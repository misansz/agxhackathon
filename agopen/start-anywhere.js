#!/usr/bin/env node
// Run the whole live mode with one command on any computer that has Node.js: no AgOpenWeb, no .NET.
//
//   npm install
//   npm run demo                      (same as: node agopen/start-anywhere.js)
//
// It writes the farm, starts four stand-in vehicles (agopen/mock-node.js: tractors T1, T2, T3 and the fuel
// truck), starts the coordinator (agopen/live.js) and opens the dashboard. Stop everything with Ctrl+C.
//
// The stand-in vehicles answer the same commands and send the same telemetry as the real ones, but they move
// by a simple model of their own. The real demo drives AgOpenWeb copies: see agopen/README.md, "Set up once".
//
// Options:
//   --speed 2          vehicles move twice as fast (default 1)
//   --page 5190        dashboard port
//   --base 5175        first vehicle port (four in a row; each vehicle's own API is on that port plus 1000)
//   --no-open          do not open the browser
//   --fresh            reset the fields to a new random mix and forget earlier surveys
//   anything else is passed to the coordinator, for example: --weather calm   --fuel-scale 25
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const argv = process.argv.slice(2);
const take = (name, dflt) => { const i = argv.indexOf('--' + name); if (i < 0) return dflt; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = (name) => { const i = argv.indexOf('--' + name); if (i < 0) return false; argv.splice(i, 1); return true; };
const speed = take('speed', '1'), page = Number(take('page', 5190)), base = Number(take('base', 5175));
const noOpen = flag('no-open'), fresh = flag('fresh');
const liveArgs = argv.length ? argv : ['--fuel-scale', '70'];

const fail = (msg) => { console.error('\n' + msg + '\n'); process.exit(1); };
if (Number(process.versions.node.split('.')[0]) < 18) fail(`Node.js 18 or later is needed (this is ${process.versions.node}). Get it from https://nodejs.org`);
if (!fs.existsSync(path.join(repo, 'node_modules', 'ws'))) fail('Packages are not installed yet. Run this first, in the project folder:\n\n    npm install');

const multi = path.resolve(repo, '..', 'agopen-multi');
const out = path.join(here, 'out');
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(out)) if (/^lock-.*\.json$/.test(f)) fs.rmSync(path.join(out, f), { force: true });
if (fresh) {
  for (const f of ['field-memory.json', 'ai-drive.json']) fs.rmSync(path.join(out, f), { force: true });
  const fieldsDir = path.join(multi, 'data-5175', 'AgOpenWeb', 'Fields');
  if (fs.existsSync(fieldsDir)) for (const d of fs.readdirSync(fieldsDir)) fs.rmSync(path.join(fieldsDir, d, 'crop-record.json'), { force: true });
}

console.log('1/4 Writing the farm (field outlines and implement profiles)...');
const built = spawnSync(process.execPath, ['agopen/build-farm.js'], { cwd: repo, encoding: 'utf8' });
if (built.status !== 0) fail('Could not write the farm:\n' + (built.stderr || built.stdout));

const children = [];
let stopping = false;
function stopAll(code = 0) {
  if (stopping) return; stopping = true;
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => { console.log('\nStopping everything.'); stopAll(0); });
process.on('SIGTERM', () => stopAll(0));

function start(label, args, { quiet }) {
  const log = quiet ? fs.openSync(path.join(out, `${label}.log`), 'w') : null;
  // The stand-in vehicles read typed commands; give them an open pipe so they keep running in the background.
  const c = spawn(process.execPath, args, { cwd: repo, stdio: quiet ? ['pipe', log, log] : ['ignore', 'inherit', 'inherit'] });
  c.on('exit', (code) => { if (!stopping) { console.error(`\n${label} stopped unexpectedly (exit ${code}).${quiet ? ` See agopen/out/${label}.log` : ''}`); stopAll(1); } });
  children.push(c);
  return c;
}
async function waitFor(url, what, tries = 60) {
  for (let k = 0; k < tries; k++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  console.error(`\n${what} did not start. Is another copy already running on that port?`); stopAll(1);
  await new Promise(() => {});
}

console.log('2/4 Starting four stand-in vehicles (T1, T2, T3 and the fuel truck)...');
const ids = ['T1', 'T2', 'T3', 'FUEL'];
ids.forEach((id, i) => start(`mock-${id}`, ['agopen/mock-node.js', id, String(base + i), '--bay', String(i), ...(speed !== '1' ? ['--speed', speed] : [])], { quiet: true }));
for (let i = 0; i < ids.length; i++) await waitFor(`http://127.0.0.1:${base + i + 1000}/telemetry`, `Vehicle ${ids[i]} (port ${base + i + 1000})`);

console.log('3/4 Starting the coordinator...');
start('coordinator', ['agopen/live.js', '--nodes', [0, 1, 2].map(i => base + i + 1000).join(','), '--truck', String(base + 3 + 1000), '--page', String(page), ...liveArgs], { quiet: false });
await waitFor(`http://127.0.0.1:${page}/state`, `The coordinator (port ${page})`, 80);

const url = `http://localhost:${page}/`;
console.log(`\n4/4 Ready: ${url}   (assistant: ${url}chat   3D view: ${url}3d)`);
console.log(process.env.ANTHROPIC_API_KEY ? '    ANTHROPIC_API_KEY is set: the assistant and the roundtable use the language model.' : '    ANTHROPIC_API_KEY is not set: everything runs, but the assistant and the roundtable fall back to rule-written lines.');
console.log('    Stand-in vehicles, not AgOpenWeb: the small vehicle windows on the dashboard show a placeholder.');
console.log('    Stop with Ctrl+C.\n');
if (!noOpen) {
  const opener = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* open it by hand */ }
}
