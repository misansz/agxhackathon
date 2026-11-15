#!/usr/bin/env node
// Live run. The team's coordinator plans the day; each tractor is a separate process (tractor-node.js)
// wrapping its own AgOpenWeb instance. This runner sends each tractor where the plan says, watches the
// telemetry that comes back, and turns real symptoms into events the coordinator re-plans around:
//   - a tractor that stops answering               → NO_RESPONSE
//   - a tractor that acknowledges GO but stays put → GO_NOT_MOVING
//
//   node agopen/live.js [scenario.json] [--nodes 6175,6176,6177] [--cell 100] [--sec 1] [--until 240]
//                       [--script "40:fault T1 stuck;120:fault T2 dead"]   (sim-minute:command, for test cases)
// While it runs, type:  break T1 | repair T1 | fault T2 stuck|dead|ok | quit
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Simulator } from '../src/simulator.js';
import { Coordinator } from '../src/coordinator.js';
import { fmtTime, ratePerMin, IMPLEMENT_FOR, REFUEL_MIN, RESERVE_FRAC } from '../src/model.js';
import { applyTools, passKph } from './rig.js';
import { planCoverage, routeProgress } from './coverage.js';
import { buildLanes } from './lanes.js';
import { createRoundtable } from './roundtable/roundtable.js';
import { createWeather } from './weather.js';
import { createDrone } from './drone.js';
import { createChat } from './chat.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const args = process.argv.slice(2);
const opt = (name, def) => (args.includes('--' + name) ? args[args.indexOf('--' + name) + 1] : def);
const scenarioPath = args.find(a => a.endsWith('.json')) || path.join(here, 'scenario.live.json');
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const farmMeta = fs.existsSync(path.join(here, 'farm.json')) ? JSON.parse(fs.readFileSync(path.join(here, 'farm.json'), 'utf8')) : {};
const CELL = Number(opt('cell', farmMeta.cell || 20));     // metres per plan grid cell; must match the farm that was built
// Real seconds per plan minute. The plan moves a tractor one cell every 2 plan-minutes, so this value makes
// that 20 km/h: tractors drive at real speed and the plan's clock keeps pace with them.
const SEC = Number(opt('sec', +(CELL * 0.09).toFixed(2)));
const UNTIL = args.includes('--until') ? Number(opt('until', 720)) : Infinity;
// --preset starts with the scenario's job list already submitted; otherwise the operator builds the list.
const PRESET = args.includes('--preset');
const nodePorts = opt('nodes', scenario.tractors.map((_, i) => 6175 + i).join(',')).split(',').map(Number);
const script = String(opt('script', '')).split(';').filter(Boolean).map(s => ({ at: Number(s.split(':')[0]), cmd: s.slice(s.indexOf(':') + 1).trim(), done: false }));

const STALE_MS = 3000;      // no telemetry for this long → NO_RESPONSE
const STUCK_MS = 8000;      // told to go, far from target, not moving for this long → GO_NOT_MOVING
const FAR_M = 40, MOVED_M = 5;
const NEAR_STUCK_MS = 12000; // the same, close to its target (turning, lining up): under 1.5 m in this long

// ---- The farm comes from AgOpenWeb's own field folders (one folder per field, field.geojson inside).
const FIELDS_DIR = opt('fields', path.resolve(here, '../../agopen-multi/data-5175/AgOpenWeb/Fields'));
const farmFile = path.join(here, 'farm.json');
const HOME = fs.existsSync(farmFile) ? JSON.parse(fs.readFileSync(farmFile, 'utf8')).home : null;
const RAD = Math.PI / 180;
const toWorld = (lat, lon) => {
  const mLat = 111132.92 - 559.82 * Math.cos(2 * HOME.lat * RAD) + 1.175 * Math.cos(4 * HOME.lat * RAD);
  const mLon = 111412.84 * Math.cos(lat * RAD) - 93.5 * Math.cos(3 * lat * RAD);
  return { e: (lon - HOME.lon) * mLon, n: (lat - HOME.lat) * mLat };
};
function readAgFields() {
  if (!fs.existsSync(FIELDS_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(FIELDS_DIR)) {
    const file = path.join(FIELDS_DIR, name, 'field.geojson');
    if (!fs.existsSync(file)) continue;
    try {
      const geo = JSON.parse(fs.readFileSync(file, 'utf8'));
      const role = (r) => geo.features.filter(f => f.properties?.role === r);
      const outer = role('outer-boundary')[0];
      out.push({
        name: role('metadata')[0]?.properties?.name || name,
        boundary: outer ? outer.geometry.coordinates[0].map(([lon, lat]) => [lon, lat]) : [],
        tracks: role('track').map(t => ({ name: t.properties.name, line: t.geometry.coordinates.map(([lon, lat]) => [lon, lat]) })),
      });
    } catch { /* skip a field file we cannot read */ }
  }
  return out;
}
const agFields = readAgFields();
const geom = {};   // field name → outline and guidance line in metres from the depot, as read from AgOpenWeb
if (HOME) {
  let added = 0;
  for (const af of agFields) {
    if (af.boundary.length < 4) continue;
    const pts = af.boundary.map(([lon, lat]) => toWorld(lat, lon));
    let a2 = 0;
    for (let i = 0; i < pts.length - 1; i++) a2 += pts[i].e * pts[i + 1].n - pts[i + 1].e * pts[i].n;
    const line = af.tracks[0]?.line.map(([lon, lat]) => toWorld(lat, lon));
    geom[af.name] = { boundary: pts, abLine: line && line.length >= 2 ? { a: line[0], b: line[line.length - 1] } : null, acres: Math.abs(a2) / 2 / 4047 };
    const known = scenario.fields.find(f => f.name === af.name);
    if (known) { known.acres = +geom[af.name].acres.toFixed(2); continue; }   // the outline in AgOpenWeb is the truth for area
    const e0 = Math.min(...pts.map(p => p.e)), e1 = Math.max(...pts.map(p => p.e)), n0 = Math.min(...pts.map(p => p.n)), n1 = Math.max(...pts.map(p => p.n));
    let area = 0;
    for (let i = 0; i < pts.length - 1; i++) area += pts[i].e * pts[i + 1].n - pts[i + 1].e * pts[i].n;
    scenario.fields.push({
      id: `A${++added}`, name: af.name, crop: 'not set', acres: Math.max(1, Math.round(Math.abs(area) / 2 / 4047)),
      x: scenario.depot.x + Math.round(e0 / CELL), y: scenario.depot.y - Math.round(n1 / CELL),
      w: Math.max(1, Math.round((e1 - e0) / CELL)), h: Math.max(1, Math.round((n1 - n0) / CELL)),
    });
  }
  console.log(`AgOpenWeb fields: ${agFields.length} found in ${FIELDS_DIR}${added ? `, ${added} not in the scenario and added` : ''}.`);
}

// ---- Each tractor's implements are the tool profiles in its own AgOpenWeb; the mounted one is its active profile.
const rigs = await Promise.all(nodePorts.map(async (p) => {
  try { return (await (await fetch(`http://127.0.0.1:${p}/telemetry`, { signal: AbortSignal.timeout(1500) })).json()).rig; } catch { return null; }
}));
scenario.tractors.forEach((t, i) => {
  const tools = applyTools(t, rigs[i]?.tools || [], rigs[i]?.activeTool);
  if (tools) console.log(`${t.id} from AgOpenWeb: ${tools.map(x => `${x.profile} = ${x.kind}, ${x.widthM} m, ${t.workRates[x.kind]} ac/h`).join('; ')}; mounted: ${t.mounted}`);
  else console.log(`${t.id}: no implement profiles found in AgOpenWeb; using the scenario's list.`);
  // The plan's clock runs faster than a wall clock (one plan minute = SEC real seconds), so a rate in acres
  // per real hour becomes this many acres per plan hour. Travel is already consistent by construction.
  for (const k of Object.keys(t.workRates)) t.workRates[k] = +(t.workRates[k] * SEC / 60).toFixed(3);
});
// On this miniature farm a whole field burns about 2% of a tank, so nothing would ever need fuel. Fuel use
// is scaled up so that refuelling decisions actually arise during a short demo. Set --fuel-scale 1 for true rates.
const FUEL_SCALE = Number(opt('fuel-scale', 25));
for (const t of scenario.tractors) { t.burnPerAcre = +(t.burnPerAcre * FUEL_SCALE).toFixed(2); t.burnPerCell = +(t.burnPerCell * Math.min(2, FUEL_SCALE)).toFixed(2); }
const presetJobs = scenario.jobs.map(({ acres, ...j }) => j);   // areas come from the field outlines
scenario.jobs = PRESET ? presetJobs : [];

const sim = new Simulator({ ...scenario, events: [] }, new Coordinator(), { scriptedEvents: false });
// Everything that changes the plan's world is recorded, so the 3D view can replay exactly the same day.
const replay = [];
const _inject = sim.inject.bind(sim);
sim.inject = (e) => { const ev = { ...e, time: Math.max(e.time ?? sim.time, sim.time) }; replay.push({ t: ev.time, kind: 'event', event: ev }); return _inject(ev); };
const dep = sim.depot;
const world = (c) => ({ e: (c.x - dep.x) * CELL, n: -(c.y - dep.y) * CELL });
// Each tractor has its own parking bay at the depot, 10 m apart, so parked machines never share a spot.
const bay = (i) => ({ e: (i - (scenario.tractors.length - 1) / 2) * 10, n: 0 });

fs.mkdirSync(path.join(here, 'out'), { recursive: true });
const trailFile = path.join(here, 'out', 'trail.jsonl');
fs.writeFileSync(trailFile, '');
let trail = function (from, to, type, text, data = {}) {
  const row = { wall: new Date().toISOString(), clock: fmtTime(sim.time), from, to, type, text, ...data };
  fs.appendFileSync(trailFile, JSON.stringify(row) + '\n');
  console.log(`[${row.clock}] ${from} → ${to}  ${type}: ${text}`);
};
sim.listeners.push((e) => {
  if (!['plan', 'event', 'done'].includes(e.type)) return;
  const who = e.type === 'plan' ? ['planner', 'executor'] : e.type === 'done' ? ['executor', 'planner'] : ['world', 'planner'];
  // A re-plan carries the planner's own explanation: one line per job that moved, and why.
  trail(who[0], who[1], e.type, e.text, e.type === 'plan' && e.lines?.length ? { lines: e.lines, footer: e.footer || null } : {});
  for (const l of e.lines || []) console.log(`           ${l}`);
});
console.log(`Scenario: ${scenario.name}`);
if (PRESET) for (const e of sim.log.filter(e => e.type === 'plan')) { console.log(`[${e.clock}] ${e.text}`); for (const l of e.lines || []) console.log(`           ${l}`); }
else console.log('All tractors at home. Build the job list on the status page, then start the day.');

const units = sim.tractors.map((t, i) => ({
  id: t.id, twin: t, bay: bay(i), url: `http://127.0.0.1:${nodePorts[i]}`,
  tel: null, lastSeen: 0, fault: null, cmd: null, stuckSince: 0, anchor: null, place: 'depot', trip: null,
}));

async function call(u, method, pathname, body) {
  const res = await fetch(u.url + pathname, {
    method, signal: AbortSignal.timeout(700),
    ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
  });
  return method === 'GET' ? res.json() : res.text();
}

// ---- Field work. Each job gets one coverage route for its field: parallel passes one implement-width
// apart along the field's guidance line, turning in the headland, then a lap round the boundary. The route
// belongs to the job, not the tractor, so if another tractor takes the job over it carries on from the
// same waypoint: nothing is repeated and nothing is missed.
const RUN = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
// Push every edge of a convex outline outward by d metres (inward for a negative d).
function growConvex(pts, d) {
  const p = pts.length > 1 && Math.hypot(pts[0].e - pts[pts.length - 1].e, pts[0].n - pts[pts.length - 1].n) < 0.01 ? pts.slice(0, -1) : pts;
  let area2 = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; area2 += a.e * b.n - b.e * a.n; }
  const sign = area2 > 0 ? 1 : -1;                         // counter-clockwise outlines have their outside on the right
  const lines = p.map((a, i) => {
    const b = p[(i + 1) % p.length], L = Math.hypot(b.e - a.e, b.n - a.n) || 1;
    const ne = (b.n - a.n) / L * sign, nn = -(b.e - a.e) / L * sign;       // unit normal pointing out of the field
    return { e: a.e + ne * d, n: a.n + nn * d, de: (b.e - a.e) / L, dn: (b.n - a.n) / L };
  });
  return lines.map((l1, i) => {
    const l0 = lines[(i + lines.length - 1) % lines.length];
    const det = l0.de * l1.dn - l0.dn * l1.de;
    if (Math.abs(det) < 1e-9) return { e: l1.e, n: l1.n };
    const t = ((l1.e - l0.e) * l1.dn - (l1.n - l0.n) * l1.de) / det;
    return { e: l0.e + l0.de * t, n: l0.n + l0.dn * t };
  });
}
const routes = new Map();
function routeFor(job, u) {
  let r = routes.get(job.id);
  if (r) return r;
  const f = sim.fields.get(job.fieldId), kind = IMPLEMENT_FOR[job.type];
  const tools = u.tel?.rig?.tools || [];
  const width = tools.find(x => x.kind === kind)?.widthM || u.tel?.rig?.tool?.widthM || 12;
  let g = geom[f.name];
  if (!g) {   // no outline in AgOpenWeb: fall back to the plan's rectangle
    const a = world({ x: f.x, y: f.y }), b = world({ x: f.x + f.w, y: f.y + f.h });
    g = { boundary: [{ e: a.e, n: a.n }, { e: b.e, n: a.n }, { e: b.e, n: b.n }, { e: a.e, n: b.n }], abLine: null };
  }
  const abLine = g.abLine || { a: g.boundary[0], b: g.boundary[1] };
  // Work the field the way a farmer does: every pass runs the full length, edge to edge, with the implement
  // inside the boundary (the outer passes have their edge on it), and the tractor drives out past the
  // boundary to turn round. Nothing outside the field is worked, and no lap round the inside is needed.
  const plan = planCoverage({ boundary: g.boundary, abLine, width, headlandPasses: 0, edgeToEdge: true, overrun: 3, start: u.tel ? { e: u.tel.e, n: u.tel.n } : null });
  // Legs to drive. Before each pass there is a straight run-up in the headland so the tractor is lined up
  // before the implement goes on. Every working leg is driven as a line (from → to), not as a point to aim at.
  const pts = [];
  const runUp = 9;                                            // metres of straight approach, outside the field
  for (let i = 0; i < plan.route.length; i++) {
    const p = plan.route[i], prev = plan.route[i - 1];
    if (p.kind === 'pass-start') {
      const end = plan.route[i + 1], L = Math.hypot(end.e - p.e, end.n - p.n) || 1;
      const back = { e: p.e - (end.e - p.e) / L * runUp, n: p.n - (end.n - p.n) / L * runUp };
      pts.push({ ...back, kind: 'turn', swath: p.swath });                                   // turn in the headland
      pts.push({ e: p.e, n: p.n, from: back, track: true, kind: 'run-up', swath: p.swath }); // line up, implement off
    } else if (p.kind === 'pass-end') {
      pts.push({ e: p.e, n: p.n, from: { e: prev.e, n: prev.n }, track: true, paint: true, kind: 'pass', swath: p.swath });
    } else if (p.paint) {
      pts.push({ e: p.e, n: p.n, from: { e: prev.e, n: prev.n }, track: true, paint: true, kind: 'headland', swath: null });
    } else {
      pts.push({ e: p.e, n: p.n, kind: 'turn', swath: null });
    }
  }
  const len = (q) => (q.from ? Math.hypot(q.e - q.from.e, q.n - q.from.n) : 0);
  const paintLen = pts.reduce((acc, q) => acc + (q.paint ? len(q) : 0), 0);
  r = { plan, pts, i: 0, done: false, width, kind, field: f.name, fraction: 0, paintLen, painted: 0, fieldM2: (g.acres ?? f.acres) * 4047 };
  routes.set(job.id, r);
  trail('route-planner', 'executor', 'route', `${sim.label(job)}: ${plan.swaths.length} full-length passes at ${width} m, turning outside the field, ${Math.round(plan.lengthM)} m to drive.`, { job: job.id });
  return r;
}
// Move along a job's legs as the tractor really completes them, and measure how much has been worked.
function advanceRoute(r, u) {
  if (!u.tel || r.done) return;
  const along = (q) => { const L = Math.hypot(q.e - q.from.e, q.n - q.from.n) || 1; return ((u.tel.e - q.from.e) * (q.e - q.from.e) + (u.tel.n - q.from.n) * (q.n - q.from.n)) / L; };
  const len = (q) => Math.hypot(q.e - q.from.e, q.n - q.from.n);
  for (let guard = 0; guard < 3; guard++) {
    const q = r.pts[r.i];
    const reached = q.track ? along(q) >= len(q) - 0.6 : Math.hypot(q.e - u.tel.e, q.n - u.tel.n) < 3.5;
    if (!reached) break;
    if (q.paint) r.painted += len(q);
    if (r.i >= r.pts.length - 1) { r.done = true; break; }
    r.i++;
  }
  const q = r.pts[r.i];
  const partial = !r.done && q.paint ? Math.max(0, Math.min(len(q), along(q))) : 0;
  r.cur = partial > 0 ? { e: q.from.e + (q.e - q.from.e) * partial / len(q), n: q.from.n + (q.n - q.from.n) * partial / len(q) } : null;
  r.fraction = r.done ? 1 : Math.max(r.fraction, (r.painted + partial) / (r.paintLen || 1));
}

// ---- Getting about. Tractors keep to the farm's lanes: a network that runs between the fields, crosses
// the creek only at the bridges, and reaches each field at a gate. They never cut across another field.
const laneNet = buildLanes(scenario, { cell: CELL });
function tripTarget(u, dest) {
  if (!u.trip || u.trip.dest !== dest) {
    const pts = (u.place !== dest && laneNet.routeBetween(u.place, dest)) || null;
    u.trip = { dest, pts: pts && pts.length ? pts : [dest === 'depot' ? { e: 0, n: 0 } : laneNet.gates[dest] || world(sim.fields.get(dest).entry)], i: 0 };
    // Join the lane at the nearest point rather than doubling back to its start.
    if (u.tel) { let best = Infinity; u.trip.pts.forEach((p, k) => { const d = Math.hypot(p.e - u.tel.e, p.n - u.tel.n); if (d < best - 1e-6) { best = d; u.trip.i = k; } }); }
  }
  const tr = u.trip;
  while (u.tel && tr.i < tr.pts.length - 1 && Math.hypot(tr.pts[tr.i].e - u.tel.e, tr.pts[tr.i].n - u.tel.n) < 6) tr.i++;
  const last = tr.i >= tr.pts.length - 1;
  if (last && u.tel && Math.hypot(tr.pts[tr.i].e - u.tel.e, tr.pts[tr.i].n - u.tel.n) < 6) u.place = dest;
  if (dest === 'depot' && (last || u.place === 'depot')) return { ...u.bay };       // off the lane and into its own bay
  return { ...tr.pts[tr.i] };
}

// Holds placed by an agent (for example the weather agent stopping spraying). A tractor on a held job
// stops where it is with the implement off; the job makes no progress until the hold is lifted.
const holds = new Map();
// A recall sends every tractor back to its depot bay along the lanes, and keeps it there, until it is lifted.
const recalls = new Map();
const heldBy = (job) => [...holds.values()].find(h => (h.jobTypes.includes('*') || h.jobTypes.includes(job.type)) && (!h.fields || h.fields.includes(sim.fields.get(job.fieldId)?.name)));

function targetFor(u) {
  const t = u.twin;
  if (t.status !== 'ok') return null;
  if (recalls.size) return { ...tripTarget(u, 'depot'), label: `recalled to the depot: ${[...recalls.values()][0].reason}`, maxKph: 20 };
  if (u.fieldRefuel) return u.tel ? { e: u.tel.e, n: u.tel.n, label: `stopped in ${sim.fields.get(u.fieldRefuel.field)?.name || 'the field'}: waiting for the fuel truck`, maxKph: 0 } : null;
  const depotTask = tasks.find(x => x.tractor === u.id && x.state !== 'done' && x.kind !== 'field-refuel');
  if (depotTask) return { ...tripTarget(u, 'depot'), label: `depot: ${depotTask.text.toLowerCase()} (waiting for a person)`, maxKph: 20 };
  if (t.action?.kind === 'work' && t.jobId) {
    const job = sim.jobs.get(t.jobId), f = sim.fields.get(job.fieldId);
    // Still on the lane: reach this field's gate first. The field is only opened in AgOpenWeb once we are there.
    if (u.place !== job.fieldId) return { ...tripTarget(u, job.fieldId), label: `lane to ${sim.label(job)}`, maxKph: 20 };
    u.trip = null;
    const h = heldBy(job);
    if (h && u.tel) return { e: u.tel.e, n: u.tel.n, label: `${sim.label(job)}: on hold (${h.reason})`, maxKph: 0, field: f.name };
    const r = routeFor(job, u);
    advanceRoute(r, u);
    const p = r.pts[r.i];
    if (r.done) return { e: p.e, n: p.n, label: `${sim.label(job)}: field covered`, maxKph: 0, field: f.name };
    const what = p.kind === 'headland' ? 'headland lap' : p.kind === 'turn' && p.swath == null ? 'turning' : `pass ${p.swath + 1} of ${r.plan.swaths.length}${p.kind === 'pass' ? '' : ' (turning outside the field)'}`;
    return {
      e: p.e, n: p.n, from: p.from || null, track: !!p.track, paint: !!p.paint,
      label: `${sim.label(job)}: ${what}, ${Math.round(r.fraction * 100)}% worked`,
      maxKph: p.paint ? Math.min(16, passKph(r.kind)) : p.track ? 7 : 9, field: f.name,
      job: { task: `${RUN}-${job.id}-${job.type}`, workType: job.type, notes: `Assigned by fleet coordinator, priority ${job.priority}, due ${fmtTime(job.deadline)}` },
    };
  }
  // Travelling: follow the lanes to wherever the plan is sending this tractor.
  const a = t.action;
  const dest = a?.kind === 'goto' ? (a.purpose === 'job' && t.jobId ? sim.jobs.get(t.jobId).fieldId : 'depot') :
    (a?.kind === 'swap' || a?.kind === 'refuel' || (t.x === dep.x && t.y === dep.y)) ? 'depot' : null;
  if (!dest) return u.tel ? { e: u.tel.e, n: u.tel.n, label: 'standing by', maxKph: 0 } : null;
  const label = a?.kind === 'goto' ? (dest === 'depot' ? `lane to the depot (${a.purpose})` : `lane to ${sim.label(sim.jobs.get(t.jobId))}`) :
    a?.kind === 'swap' ? 'depot: changing implement' : a?.kind === 'refuel' ? 'depot: refuelling' : 'standing by at the depot';
  return { ...tripTarget(u, dest), label, maxKph: 20 };
}

// The plan's idea of how much of a job is left is overwritten each minute with what the tractor has really
// covered, so a job finishes when the field is done, not when a timer runs out.
function syncProgress() {
  for (const u of units) {
    const t = u.twin;
    if (t.status !== 'ok' || t.action?.kind !== 'work' || !t.jobId) continue;
    const job = sim.jobs.get(t.jobId), r = routes.get(job.id);
    if (!r) continue;
    const perMin = ratePerMin(t, job.type);
    job.remaining = r.done ? Math.min(job.remaining, perMin * 0.5) : Math.max(job.acres * (1 - r.fraction), perMin * 1.5);
    replay.push({ t: sim.time, kind: 'progress', job: job.id, remaining: job.remaining });
  }
}

// Give way. If two moving tractors come within 9 m, the one doing less important work stops where it is
// until they are 13 m apart again. A tractor that is working a pass keeps going; otherwise the lower-numbered
// tractor has right of way.
function givingWayTo(u) {
  if (!u.tel) return null;
  for (const o of units) {
    if (o === u || !o.tel || o.twin.status !== 'ok') continue;
    const d = Math.hypot(u.tel.e - o.tel.e, u.tel.n - o.tel.n);
    const limit = u.yieldTo === o.id ? 13 : 9;
    if (d > limit) continue;
    const oMoving = o.tel.speedKph > 0.5, uWorking = u.cmd?.paint, oWorking = o.cmd?.paint;
    const iYield = oMoving && (oWorking && !uWorking ? true : uWorking && !oWorking ? false : units.indexOf(u) > units.indexOf(o));
    if (iYield) return o;
  }
  return null;
}

async function dispatch() {
  for (const u of units) {
    let tg = targetFor(u);
    const other = tg && tg.maxKph !== 0 ? givingWayTo(u) : null;
    u.yieldTo = other ? other.id : null;
    if (other) tg = { e: u.tel.e, n: u.tel.n, label: `giving way to ${other.id}`, maxKph: 0, field: tg.field };
    const cmd = tg ? { type: 'goto', e: +tg.e.toFixed(2), n: +tg.n.toFixed(2), label: tg.label, maxKph: tg.maxKph, field: tg.field || null, from: tg.from || null, track: !!tg.track, paint: !!tg.paint, job: tg.job || null } : { type: 'stop', label: 'out of service' };
    const key = JSON.stringify(cmd);
    if (key === u.lastKey && Date.now() - (u.lastSent || 0) < 4000) continue;
    u.cmd = cmd; u.lastKey = key; u.lastSent = Date.now();
    call(u, 'POST', '/command', cmd).catch(() => {});
  }
}

let lastFault = null;
function raise(u, kind, signal) {
  if (u.fault || u.twin.status !== 'ok') return;
  u.fault = kind; lastFault = { tractor: u.id, kind, signal };
  if (u.tel) { drone.assign({ type: 'investigate', target: { e: u.tel.e, n: u.tel.n }, subject: u.id, symptom: kind }); trail('fault-detector', 'drone', 'dispatch', `Drone sent to look at ${u.id}.`); }
  trail('fault-detector', 'planner', 'fault', `${u.id} ${kind}: ${signal}`, { tractor: u.id, kind });
  sim.inject({ type: 'breakdown', tractor: u.id, note: kind === 'NO_RESPONSE' ? 'stopped responding' : 'GO acknowledged but GPS position not changing', source: 'telematics', signal: `${kind} — ${signal}` });
}
function clear(u, why) {
  if (u.twin.status !== 'broken') { u.fault = null; return; }
  u.fault = null; u.stuckSince = 0; u.anchor = null;
  trail('fault-detector', 'planner', 'recovered', `${u.id} ${why}`, { tractor: u.id });
  sim.inject({ type: 'repair', tractor: u.id, note: why, source: 'telematics', signal: why });
}

async function poll() {
  const now = Date.now();
  await Promise.all(units.map(async (u) => {
    try { u.tel = await call(u, 'GET', '/telemetry'); u.lastSeen = now; } catch { /* silence is the signal */ }
    if (!u.lastSeen) return;                                   // never heard from it yet
    if (now - u.lastSeen > STALE_MS) { raise(u, 'NO_RESPONSE', `no telemetry for ${((now - u.lastSeen) / 1000).toFixed(1)} s`); u.wasSilent = true; return; }
    if (u.fault === 'NO_RESPONSE' && u.wasSilent && now - u.lastSeen < 500) { u.wasSilent = false; clear(u, 'is answering again'); }
    const c = u.cmd;
    if (c?.type === 'goto' && u.twin.status === 'ok' && !u.tel.busy && c.maxKph !== 0) {
      // Far from its target a tractor should cover ground quickly; close to it (turning between passes, lining
      // up) it moves slowly, so the test there is stricter on distance and waits longer. Within 5 m it has arrived.
      const d = Math.hypot(c.e - u.tel.e, c.n - u.tel.n), far = d > FAR_M;
      const mustMove = far ? MOVED_M : 1.5, within = far ? STUCK_MS : NEAR_STUCK_MS;
      if (!u.anchor || d < 5 || Math.hypot(u.tel.e - u.anchor.e, u.tel.n - u.anchor.n) > mustMove) { u.anchor = { e: u.tel.e, n: u.tel.n }; u.stuckSince = now; }
      else if (now - u.stuckSince > within) raise(u, 'GO_NOT_MOVING', `GO acknowledged (ack ${u.tel.ack}), ${Math.round(d)} m from target, moved under ${mustMove} m in ${within / 1000} s`);
    } else { u.anchor = null; u.stuckSince = now; }
  }));
}

// ---- People in the loop. Fuelling and implement changes are done by a person at the depot. The plan
// holds that tractor there, its process is locked so it cannot move, and nothing continues until someone
// presses "Good to go" in the web app. An implement change is then written to that tractor's AgOpenWeb.
const tasks = [];
const AUTO_GO_S = Number(opt('auto-humans', 0));   // for unattended test runs only
function humanGate() {
  for (const u of units) {
    if (u.fieldRefuel) continue;                             // being refuelled in the field: handled by the fuel truck below
    const a = u.twin.action;
    if (u.twin.status !== 'ok' || !a || (a.kind !== 'refuel' && a.kind !== 'swap')) continue;
    let k = tasks.find(x => x.tractor === u.id && x.state !== 'done');
    if (!k) {
      const tool = a.kind === 'swap' ? (u.tel?.rig?.tools || []).find(x => x.kind === a.impl)?.profile || a.impl : null;
      k = { id: `H${tasks.length + 1}`, tractor: u.id, kind: a.kind, impl: a.impl || null, tool, full: a.left, state: 'on-way', clock: fmtTime(sim.time), go: false };
      k.text = a.kind === 'swap' ? `Change ${u.id}'s implement to ${tool}` : `Refuel ${u.id}`;
      tasks.push(k);
      trail('planner', 'person at depot', 'request', `${k.text}. ${u.id} is heading to the depot.`, { task: k.id });
    }
    const parked = u.tel && Math.hypot(u.tel.e - u.bay.e, u.tel.n - u.bay.n) < 8 && u.tel.speedKph < 1;
    if (k.state === 'on-way' && parked) {
      k.state = 'waiting'; k.waitingSince = Date.now();
      call(u, 'POST', '/service', { kind: k.kind, tool: k.tool }).catch(() => {});
      trail('executor', 'person at depot', 'locked', `${u.id} is parked at the depot and locked. ${k.text}, then press Good to go.`, { task: k.id });
      discuss('service-request', k.text, { tractor: u.id, work: k.text, state: 'parked at the depot and locked; waiting for a person to press Good to go' });
    }
    if (AUTO_GO_S && k.state === 'waiting' && Date.now() - k.waitingSince > AUTO_GO_S * 1000) k.go = true;
    if (k.go && k.state === 'waiting') {
      k.state = 'done'; a.left = 1;                          // the work is done: the plan moves on at the next minute
      replay.push({ t: sim.time, kind: 'release', tractor: u.id });
      call(u, 'POST', '/release', {}).catch(() => {});
      trail('person at depot', 'executor', 'good-to-go', `${k.text}: done. ${u.id} is released${k.tool ? ` and its AgOpenWeb tool profile is now ${k.tool}` : ''}.`, { task: k.id });
    } else {
      a.left = k.full;                                       // hold: no fuel gauge change, no new implement, no movement
      replay.push({ t: sim.time, kind: 'hold', tractor: u.id, left: k.full });
    }
  }
}

// ---- The operator's job list. Jobs are drafted, optionally in order within a field (plow, then sow), and
// handed to the planner when the day starts. A step that must follow another is held back until the
// earlier one is finished, then released.
let mode = PRESET ? 'running' : 'building';
const backlog = [];
// What state each field's ground is in. An operation that makes no sense for that state is refused with
// a plain reason, the way a foreman would refuse it: no sowing unplowed ground, no plowing up a fresh seedbed.
const ground = Object.fromEntries(scenario.fields.map(f => [f.name, 'stubble']));
const GROUND_WORD = { stubble: 'not plowed', tilled: 'plowed', sown: 'sown' };
const groundAfter = (g, type) => (type === 'till' ? 'tilled' : type === 'seed' ? 'sown' : g);
const stillToDo = (b) => { const j = sim.jobs.get(b.id); return !b.applied && j?.status !== 'cancelled'; };
const groundOnceListDone = (fieldName) => backlog.filter(b => b.field === fieldName && stillToDo(b)).reduce((g, b) => groundAfter(g, b.type), ground[fieldName]);
function whyNot(g, type, fieldName) {
  if (type === 'seed' && g === 'stubble') return `${fieldName} has not been plowed. Add Plow before Sow.`;
  if (type === 'seed' && g === 'sown') return `${fieldName} is already sown, or will be by a job on the list.`;
  if (type === 'till' && g === 'sown') return `${fieldName} is sown, or will be by a job on the list. Plowing it would destroy the seedbed.`;
  if (type === 'mow' && g !== 'stubble') return `${fieldName} is bare soil once plowed or sown. There is nothing to mow.`;
  return null;
}
let jobSeq = 0;
const labelOf = (b) => `${b.id} ${({ till: 'Till', seed: 'Seed', spray: 'Spray', mow: 'Mow' })[b.type]} ${b.field}`;
function draftJobs({ fields = [], steps = [], priority = 'medium', deadline = '17:00' }) {
  const [hh, mm] = String(deadline).split(':').map(Number);
  const due = hh * 60 + mm - 6 * 60;
  if (!fields.length) throw new Error('Pick at least one field.');
  if (!steps.length) throw new Error('Pick at least one operation.');
  for (const st of steps) if (!IMPLEMENT_FOR[st]) throw new Error(`Unknown operation: ${st}`);
  if (!(due > sim.time)) throw new Error('The finish time has already passed.');
  // Plowing always comes before sowing, whatever order they were clicked in.
  steps = [...steps];
  if (steps.includes('till') && steps.includes('seed') && steps.indexOf('seed') < steps.indexOf('till')) { steps.splice(steps.indexOf('till'), 1); steps.splice(steps.indexOf('seed'), 0, 'till'); }
  // Check everything first, so a list is either added whole or not at all.
  for (const name of fields) {
    if (!scenario.fields.some(x => x.name === name)) throw new Error(`Unknown field: ${name}`);
    let g = groundOnceListDone(name);
    for (const type of steps) { const no = whyNot(g, type, name); if (no) throw new Error(no); g = groundAfter(g, type); }
  }
  const added = [];
  for (const name of fields) {
    const f = scenario.fields.find(x => x.name === name);
    // A step waits for the one before it in this field. Sowing also waits for any plowing already listed.
    let prev = null;
    for (const type of steps) {
      const earlierTill = type === 'seed' && !prev ? [...backlog].reverse().find(b => b.field === name && b.type === 'till' && stillToDo(b)) : null;
      const b = { id: `N${++jobSeq}`, field: f.name, fieldId: f.id, type, priority, deadline: due, waitsFor: prev || earlierTill?.id || null, status: 'draft' };
      backlog.push(b); added.push(b.id); prev = b.id;
    }
  }
  trail('operator', 'planner', 'jobs', `${added.length} job(s) drafted: ${steps.join(' then ')} on ${fields.join(', ')}.`);
  if (mode === 'running') releaseReady();
  return added;
}
function releaseReady() {
  // A finished job changes the state of its field's ground.
  for (const b of backlog) if (!b.applied && sim.jobs.get(b.id)?.status === 'done') { b.applied = true; ground[b.field] = groundAfter(ground[b.field], b.type); recordWork(b.field, b.type); droneScan(b.field); }
  const ready = backlog.filter(b => b.status !== 'released' && (!b.waitsFor || sim.jobs.get(b.waitsFor)?.status === 'done'));
  for (const b of backlog) if (b.status === 'draft' && !ready.includes(b)) b.status = 'waiting';
  if (!ready.length) return;
  for (const b of ready) b.status = 'released';
  sim.finished = false;   // new work re-opens a day that had run out of jobs
  sim.inject({ type: 'new_jobs', jobs: ready.map(b => ({ id: b.id, type: b.type, fieldId: b.fieldId, priority: b.priority, deadline: b.deadline, note: b.waitsFor ? `follows ${b.waitsFor}` : 'from the job list' })), source: 'operator', signal: 'Job list on the status page' });
}
function removeDraft(id) {
  const b = backlog.find(x => x.id === id);
  if (!b) throw new Error('No such job.');
  const doomed = [b];
  for (let grew = true; grew;) { grew = false; for (const x of backlog) if (!doomed.includes(x) && doomed.some(d => d.id === x.waitsFor)) { doomed.push(x); grew = true; } }
  if (doomed.some(x => x.status === 'released')) throw new Error('That job, or one that follows it, is already with the planner.');
  for (const x of doomed) backlog.splice(backlog.indexOf(x), 1);
}
function startDay() {
  if (mode === 'running') throw new Error('The day is already running.');
  if (!backlog.length) throw new Error('Add at least one job first.');
  mode = 'running';
  trail(aiDrive ? 'crop-manager' : 'operator', 'planner', 'start', `Day started with ${backlog.length} job(s) on the list.`);
  releaseReady();
}

// ---- Fuel truck. A fourth AgOpenWeb vehicle that carries fuel to a tractor in the field when that is
// cheaper than the tractor driving to the depot and back. The system forecasts when each tractor will need
// fuel, compares the two options in minutes of the tractor's day, and if the truck wins, sends it so that it
// reaches the field gate as the tractor finishes its job. The refuelling itself is a person's job: both
// machines are locked until Good to go.
const TRUCK_KPH = 25;
const truck = { id: 'FUEL', name: 'Fuel truck', url: `http://127.0.0.1:${opt('truck', 6178)}`, tel: null, lastSeen: 0, bay: bay(scenario.tractors.length), place: 'depot', trip: null, cmd: null, twin: { status: 'ok' } };
let fuelMission = null, fuelNote = null;
const planMin = (metres, kph) => metres / (kph / 3.6) / SEC;          // metres at a speed → minutes on the plan clock
const laneLen = (a, b) => (a === b ? 0 : laneNet.lengthBetween(a, b) ?? 0);
async function pollTruck() { try { truck.tel = await call(truck, 'GET', '/telemetry'); truck.lastSeen = Date.now(); } catch { /* no truck running: the option is simply not offered */ } }
const truckReady = () => truck.tel && Date.now() - truck.lastSeen < 3000;

// What each option costs. Both pay the same time at the pump, so that is left out: the difference is the
// extra distance the tractor drives to pass the depot, against the truck's round trip. The rates are
// assumptions and live in the scenario file under "costs".
const COST = { dieselPerGal: 4, tractorPerHour: 120, truckPerHour: 45, tankGal: 60, truckGalPerKm: 0.1, ...(scenario.costs || {}) };
function fuelOptions(u, from, next, waitMin = 0) {
  const t = u.twin;
  const extraM = Math.max(0, next ? laneLen(from, 'depot') + laneLen('depot', next) - laneLen(from, next) : 2 * laneLen(from, 'depot'));
  const depotMin = planMin(extraM, 20);
  const depotFuelPct = (extraM / CELL) * t.burnPerCell / t.fuelCapacity * 100;
  const depotCost = depotMin / 60 * COST.tractorPerHour + depotFuelPct / 100 * COST.tankGal * COST.dieselPerGal;
  const truckM = 2 * (laneLen('depot', from) + 60);
  const truckMin = planMin(truckM, TRUCK_KPH);
  const truckCost = truckMin / 60 * COST.truckPerHour + truckM / 1000 * COST.truckGalPerKm * COST.dieselPerGal + waitMin / 60 * COST.tractorPerHour;
  return {
    extraM: Math.round(extraM), depotMin: Math.round(depotMin), depotFuelPct: Math.round(depotFuelPct), depotCost: Math.round(depotCost),
    truckM: Math.round(truckM), truckMin: Math.round(truckMin), truckCost: Math.round(truckCost), waitMin: Math.round(waitMin),
    choice: truckCost < depotCost ? 'truck' : 'depot', saved: Math.round(Math.abs(depotCost - truckCost)),
  };
}
const usd = (n) => 'USD ' + n;
const optionText = (o) => (o.choice === 'truck'
  ? `Going via the depot adds ${o.extraM} m for the tractor: ${o.depotMin} min of its day and ${o.depotFuelPct}% of a tank, about ${usd(o.depotCost)}. The fuel truck's round trip is ${o.truckM} m, about ${usd(o.truckCost)}. The truck is cheaper by about ${usd(o.saved)}.`
  : `The depot is close to its way (${o.extraM} m extra, about ${usd(o.depotCost)}) against about ${usd(o.truckCost)} for the fuel truck's ${o.truckM} m round trip. It refuels at the depot.`);

const truckBusy = () => !!fuelMission && fuelMission.phase !== 'returning';     // on its way home it can be turned round
function fuelPlanning() {
  if (!truckReady()) return;
  const assign = sim.dispatcher.plan?.assign || {};
  for (const u of units) {
    const t = u.twin;
    if (t.status !== 'ok' || u.fault) continue;
    const reserve = t.fuelCapacity * RESERVE_FRAC;
    // 1. Look ahead: will this tractor need fuel when its current job ends?
    // A tractor already stopped and waiting in a field must always have the truck coming to it.
    if (u.fieldRefuel && !(truckBusy() && fuelMission.u === u)) {
      if (!truckBusy()) {
        const o = { ...fuelOptions(u, u.fieldRefuel.field, u.fieldRefuel.field), fuelPctNow: Math.round(100 * t.fuel / t.fuelCapacity) };
        fuelMission = { u, job: null, field: u.fieldRefuel.field, phase: 'to-field', numbers: o, startedAt: fmtTime(sim.time) };
        truck.trip = null;
        trail('fuel-planner', 'fuel truck', 'fuel', `${u.id} is stopped in ${sim.fields.get(u.fieldRefuel.field)?.name} at ${o.fuelPctNow}% fuel, waiting. Sending the fuel truck to it now.`, { tractor: u.id, ...o });
      }
      continue;
    }
    if (!truckBusy() && t.action?.kind === 'work' && t.jobId && u.place === sim.jobs.get(t.jobId).fieldId) {
      const job = sim.jobs.get(t.jobId), r = routes.get(job.id);
      const e = u.eta;
      if (r && e?.burnPerMin > 0 && e.out?.jobDoneInMin != null) {
        // Minutes until the planner pulls it off the job for fuel: down to the reserve plus the drive home.
        const leaveIn = Math.max(0, (t.fuel - reserve - sim.nav.distance(sim.jobField(job), sim.depot) * t.burnPerCell) / e.burnPerMin);
        if (leaveIn < e.out.jobDoneInMin) {
          const o = { ...fuelOptions(u, job.fieldId, job.fieldId), fuelPctNow: Math.round(100 * t.fuel / t.fuelCapacity), fuelLastsMin: Math.round(leaveIn), jobNeedsMin: e.out.jobDoneInMin };
          const lead = `${u.id} has fuel for about ${o.fuelLastsMin} more min of ${sim.label(job)}, and the job needs about ${o.jobNeedsMin}. `;
          if (o.choice === 'depot') {
            if (u.fuelNote !== job.id + ':mid') { u.fuelNote = job.id + ':mid'; trail('fuel-planner', 'planner', 'fuel', lead + optionText(o), { tractor: u.id, ...o }); }
          } else if (leaveIn <= o.truckMin / 2 + 2) {
            fuelMission = { u, job: job.id, field: job.fieldId, phase: 'to-field', numbers: o, startedAt: fmtTime(sim.time) }; truck.trip = null;
            const text = lead + optionText(o) + ` Sending it to ${sim.fields.get(job.fieldId).name} now so it is there when ${u.id} gets down to its reserve.`;
            trail('fuel-planner', 'fuel truck', 'fuel', text, { tractor: u.id, ...o });
            discuss('service-request', `Fuel truck to ${u.id}`, { tractor: u.id, work: `refuel ${u.id} in the field from the fuel truck`, state: text, options: o });
          }
          continue;
        }
      }
      const next = (assign[t.id] || []).map(x => sim.jobs.get(x?.id ?? x)).find(j => j && j.id !== job.id && j.status !== 'done');
      if (!r || !next) continue;
      const left = job.acres * (1 - r.fraction);
      const fuelAtEnd = t.fuel - left * t.burnPerAcre;
      const cellsOn = sim.nav.distance(sim.jobField(job), sim.jobField(next)) + sim.nav.distance(sim.jobField(next), sim.depot);
      if (fuelAtEnd >= reserve + cellsOn * t.burnPerCell + next.acres * t.burnPerAcre) continue;      // enough for the next job too
      const o = { ...fuelOptions(u, job.fieldId, next.fieldId), fuelPctNow: Math.round(100 * t.fuel / t.fuelCapacity), fuelPctAtJobEnd: Math.round(100 * fuelAtEnd / t.fuelCapacity) };
      const lead = `${u.id} will be at ${o.fuelPctAtJobEnd}% fuel when ${sim.label(job)} finishes, not enough for ${sim.label(next)}. `;
      if (o.choice === 'depot') {
        if (u.fuelNote !== job.id) {
          u.fuelNote = job.id;
          trail('fuel-planner', 'planner', 'fuel', lead + optionText(o), { tractor: u.id, ...o });
          discuss('service-request', `Fuel for ${u.id}: depot`, { tractor: u.id, work: `refuel ${u.id} at the depot on its way to the next field`, state: lead + optionText(o), options: o });
        }
        continue;
      }
      const minutesToEnd = left / ratePerMin(t, job.type);
      if (minutesToEnd > o.truckMin / 2 + 2) continue;                                                // not yet: leave so the truck arrives as the job ends
      fuelMission = { u, job: job.id, field: job.fieldId, phase: 'to-field', numbers: o, startedAt: fmtTime(sim.time) }; truck.trip = null;
      const text = lead + optionText(o) + ` Sending it to ${sim.fields.get(job.fieldId).name} now so it arrives as the job ends.`;
      trail('fuel-planner', 'fuel truck', 'fuel', text, { tractor: u.id, ...o });
      discuss('service-request', `Fuel truck to ${u.id}`, { tractor: u.id, work: `refuel ${u.id} in the field from the fuel truck`, state: text, options: o });
    }
    // 2. The planner has just sent this tractor to the depot for fuel while it is out at a field.
    //    If the truck is already coming for it, or is the cheaper option, it stays put and is refuelled there.
    if (!u.fieldRefuel && t.action?.kind === 'goto' && t.action.purpose === 'refuel' && u.place !== 'depot') {
      const mine = truckBusy() && fuelMission.u === u;
      if (!mine) {
        if (truckBusy()) continue;                                                                     // the truck is busy: go to the depot as planned
        const wait = planMin(laneLen('depot', u.place) + 60, TRUCK_KPH);
        const next = (assign[t.id] || []).map(x => sim.jobs.get(x?.id ?? x)).find(j => j && j.status !== 'done');
        const o = { ...fuelOptions(u, u.place, next?.fieldId, wait), fuelPctNow: Math.round(100 * t.fuel / t.fuelCapacity) };
        if (o.choice === 'depot') {
          if (t.action.fuelNoted) continue;
          t.action.fuelNoted = true;                                                                   // say why, once per trip
          trail('fuel-planner', 'planner', 'fuel', `${u.id} needs fuel now, at ${o.fuelPctNow}%. ` + optionText(o) + ` The truck figure includes ${o.waitMin} min of the tractor waiting for it.`, { tractor: u.id, ...o });
          continue;
        }
        fuelMission = { u, job: null, field: u.place, phase: 'to-field', numbers: o, startedAt: fmtTime(sim.time) }; truck.trip = null;
        const text = `${u.id} needs fuel now, at ${o.fuelPctNow}%. ` + optionText(o) + ` That includes ${o.waitMin} min waiting for the truck. Sending it.`;
        trail('fuel-planner', 'fuel truck', 'fuel', text, { tractor: u.id, ...o });
        discuss('service-request', `Fuel truck to ${u.id}`, { tractor: u.id, work: `refuel ${u.id} in the field from the fuel truck`, state: text, options: o });
      }
      u.fieldRefuel = { field: u.place };
      t.action = { kind: 'refuel', left: REFUEL_MIN };        // the plan now shows it refuelling where it stands
    }
    if (u.fieldRefuel && t.action?.kind === 'refuel') {
      const k = fuelMission?.task;
      if (k?.go) { k.state = 'done'; t.action.left = 1; }      // released: the gauge fills on the next plan minute
      else t.action.left = REFUEL_MIN;                         // held: no fuel yet, nothing moves
    }
  }
}

// ---- Forecasts shown to the operator. Both come from what the tractor is actually achieving, smoothed over
// the last few plan minutes: how fast the job's worked share is rising, and how fast the gauge is falling.
// How far the tractor is from where the plan expects it. On the lanes that is the plan's own position. In a
// field the plan only knows "in this field", so the gap is measured from the pass line the tractor is on;
// turning between passes, outside the boundary, counts as on plan.
function planGap(u, w) {
  if (!u.tel) return null;
  const c = u.cmd;
  if (c?.type === 'goto' && c.field) {
    if (!c.from) return 0;
    const ax = c.from.e, ay = c.from.n, dx = c.e - ax, dy = c.n - ay, L2 = dx * dx + dy * dy || 1;
    const k = Math.max(0, Math.min(1, ((u.tel.e - ax) * dx + (u.tel.n - ay) * dy) / L2));
    return Math.round(Math.hypot(u.tel.e - (ax + dx * k), u.tel.n - (ay + dy * k)));
  }
  // On a lane trip: distance off the lane, once the tractor has joined it. The plan's own position moves a
  // grid cell at a time and runs ahead or behind by a field's length, which is timing, not a tractor off course.
  const tr = u.trip;
  if (c?.type === 'goto' && c.maxKph > 0 && tr?.pts?.length && u.place !== tr.dest) {
    const a = tr.pts[Math.max(0, tr.i - 1)], b = tr.pts[tr.i], dx = b.e - a.e, dy = b.n - a.n, L2 = dx * dx + dy * dy || 1;
    const k = Math.max(0, Math.min(1, ((u.tel.e - a.e) * dx + (u.tel.n - a.n) * dy) / L2));
    const d = Math.hypot(u.tel.e - (a.e + dx * k), u.tel.n - (a.n + dy * k));
    if (d < 10) tr.joined = true;
    return tr.joined ? Math.round(d) : 0;
  }
  if (c?.type === 'goto' && c.maxKph === 0 && u.place !== 'depot') return 0;      // told to wait where it stands
  return Math.round(Math.hypot(w.e - u.tel.e, w.n - u.tel.n));
}

function updateEtas() {
  const assign = sim.dispatcher.plan?.assign || {};
  for (const u of units) {
    const t = u.twin, e = (u.eta ||= {});
    const reserve = t.fuelCapacity * RESERVE_FRAC;
    const burn = e.lastFuel != null ? e.lastFuel - t.fuel : 0;
    if (burn > 0) e.burnPerMin = e.burnPerMin ? e.burnPerMin * 0.7 + burn * 0.3 : burn;
    e.lastFuel = t.fuel;
    const working = t.status === 'ok' && t.action?.kind === 'work' && t.jobId;
    const job = working ? sim.jobs.get(t.jobId) : null, r = job ? routes.get(job.id) : null;
    if (!job || !r) { e.jobId = null; e.out = { fuelPct: Math.round(100 * t.fuel / t.fuelCapacity) }; continue; }
    if (e.jobId !== job.id) { e.jobId = job.id; e.lastFrac = r.fraction; e.fracPerMin = null; }
    const gain = r.fraction - e.lastFrac;
    if (gain > 0) e.fracPerMin = e.fracPerMin ? e.fracPerMin * 0.7 + gain * 0.3 : gain;
    e.lastFrac = r.fraction;
    const nominal = ratePerMin(t, job.type) / job.acres;                         // share of the job per plan minute at the rated speed
    const rate = e.fracPerMin || nominal;
    const jobMin = (1 - r.fraction) / rate;
    const fuelMin = e.burnPerMin > 0 ? Math.max(0, (t.fuel - reserve) / e.burnPerMin) : null;
    const next = (assign[t.id] || []).map(x => sim.jobs.get(x?.id ?? x)).find(j => j && j.id !== job.id && j.status !== 'done');
    const fuelAtEnd = t.fuel - (e.burnPerMin || 0) * jobMin;
    let fuelPlan = null;
    if (next) {
      const cellsOn = sim.nav.distance(sim.jobField(job), sim.jobField(next)) + sim.nav.distance(sim.jobField(next), sim.depot);
      const needs = fuelAtEnd < reserve + cellsOn * t.burnPerCell + next.acres * t.burnPerAcre;
      const o = truckReady() ? fuelOptions(u, job.fieldId, next.fieldId) : null;
      fuelPlan = { next: sim.label(next), needsFuelFirst: needs, ...(needs && o ? { choice: o.choice, depotCost: o.depotCost, depotExtraM: o.extraM, truckCost: o.truckCost, truckRoundTripM: o.truckM } : {}) };
    }
    if (fuelMin != null && fuelMin < jobMin && truckReady()) {
      const o = fuelOptions(u, job.fieldId, job.fieldId);
      fuelPlan = { next: `the rest of ${sim.label(job)}`, needsFuelFirst: true, choice: o.choice, depotCost: o.depotCost, depotExtraM: o.extraM, truckCost: o.truckCost, truckRoundTripM: o.truckM };
    }
    e.out = {
      fuelPct: Math.round(100 * t.fuel / t.fuelCapacity),
      jobDoneInMin: Math.round(jobMin), jobDoneAt: fmtTime(sim.time + jobMin), ratePctPerMin: +(rate * 100).toFixed(1), measured: !!e.fracPerMin,
      fuelToReserveInMin: fuelMin == null ? null : Math.round(fuelMin), fuelToReserveAt: fuelMin == null ? null : fmtTime(sim.time + fuelMin),
      fuelPctAtJobEnd: Math.max(0, Math.round(100 * fuelAtEnd / t.fuelCapacity)), runsShortBeforeJobEnds: fuelMin != null && fuelMin < jobMin,
      fuelPlan,
    };
  }
}

function truckTick() {
  if (!truckReady()) return;
  const m = fuelMission;
  let tg = { ...truck.bay, label: 'parked at the depot', maxKph: 0 };
  if (m) {
    const u = m.u, t = u.twin;
    const gone = t.status !== 'ok' || u.fault;
    if (gone && m.phase !== 'returning') { m.phase = 'returning'; if (u.fieldRefuel) { u.fieldRefuel = null; } trail('fuel-planner', 'fuel truck', 'fuel', `${u.id} is out of service. Fuel truck returning to the depot.`); }
    if (m.phase === 'to-field') {
      tg = { ...tripTarget(truck, m.field), label: `lane to ${sim.fields.get(m.field)?.name}, to refuel ${u.id}`, maxKph: TRUCK_KPH };
      if (truck.place === m.field) m.phase = 'meet';
      // The job ended and the planner did not ask for fuel after all: stand down.
      if (m.job && sim.jobs.get(m.job)?.status === 'done' && !u.fieldRefuel && t.action?.purpose !== 'refuel' && (m.idle = (m.idle || 0) + 1) > 40) m.phase = 'returning';
    }
    if (m.phase === 'meet') {
      tg = { e: truck.tel.e, n: truck.tel.n, label: `at ${sim.fields.get(m.field)?.name} gate, waiting for ${u.id} to finish`, maxKph: 0 };
      if (u.fieldRefuel && u.tel && u.tel.speedKph < 1) {
        const d = Math.hypot(u.tel.e - truck.tel.e, u.tel.n - truck.tel.n) || 1;
        // Pull up 7 m short of the tractor, on the line between them.
        tg = { e: u.tel.e + (truck.tel.e - u.tel.e) / d * 7, n: u.tel.n + (truck.tel.n - u.tel.n) / d * 7, label: `driving to ${u.id} to refuel it`, maxKph: 12 };
        if (d < 14 && truck.tel.speedKph < 1) {                // alongside: the truck stops a few metres from the point it is sent to
          m.phase = 'fuelling';
          m.task = { id: `H${tasks.length + 1}`, tractor: u.id, kind: 'field-refuel', text: `Refuel ${u.id} from the fuel truck in ${sim.fields.get(m.field)?.name}`, state: 'waiting', clock: fmtTime(sim.time), go: false, waitingSince: Date.now() };
          tasks.push(m.task);
          call(u, 'POST', '/service', { kind: 'refuel' }).catch(() => {});
          call(truck, 'POST', '/service', { kind: 'refuel' }).catch(() => {});
          trail('executor', 'person at depot', 'locked', `${u.id} and the fuel truck are stopped together in ${sim.fields.get(m.field)?.name} and locked. ${m.task.text}, then press Good to go.`, { task: m.task.id });
        }
      }
      if (!u.fieldRefuel && m.job && sim.jobs.get(m.job)?.status === 'done' && t.action?.purpose !== 'refuel' && (m.idle = (m.idle || 0) + 1) > 60) m.phase = 'returning';
    }
    if (m.phase === 'fuelling') {
      tg = { e: truck.tel.e, n: truck.tel.n, label: `refuelling ${u.id} (waiting for Good to go)`, maxKph: 0 };
      if (AUTO_GO_S && Date.now() - m.task.waitingSince > AUTO_GO_S * 1000) m.task.go = true;
      if (m.task.state === 'done' || (m.task.go && !u.fieldRefuel)) {
        call(u, 'POST', '/release', {}).catch(() => {});
        call(truck, 'POST', '/release', {}).catch(() => {});
        u.fieldRefuel = null; truck.trip = null; m.phase = 'returning';
        trail('person at depot', 'executor', 'good-to-go', `${m.task.text}: done. ${u.id} is full and released; the fuel truck is heading back.`, { task: m.task.id });
        discuss('service-done', `${u.id} refuelled in the field`, { tractor: u.id, work: m.task.text, state: `refuelled in the field; about USD ${m.numbers.saved} cheaper than a depot trip`, options: m.numbers });
      }
    }
    if (m.phase === 'returning') {
      tg = { ...tripTarget(truck, 'depot'), label: 'lane back to the depot', maxKph: TRUCK_KPH };
      if (Math.hypot(truck.tel.e - truck.bay.e, truck.tel.n - truck.bay.n) < 8) { truck.place = 'depot'; truck.trip = null; fuelMission = null; }
    }
  }
  const cmd = { type: tg.maxKph === 0 ? 'goto' : 'goto', e: +tg.e.toFixed(2), n: +tg.n.toFixed(2), label: tg.label, maxKph: tg.maxKph };
  const key = JSON.stringify(cmd);
  if (key === truck.lastKey && Date.now() - (truck.lastSent || 0) < 4000) return;
  truck.cmd = cmd; truck.lastKey = key; truck.lastSent = Date.now();
  call(truck, 'POST', '/command', cmd).catch(() => {});
}

// ---- Spray or wait. Weather is read at two heights once a plan minute. A Stop holds every spray job,
// tractor or drone, until conditions clear; the rules are plain code and every reading is logged.
const weather = createWeather({ day: opt('weather', 'demo') });
const WEATHER_HOLD = 'weather-spray';
function weatherTick() {
  const { reading, assessment, changed } = weather.step(sim.time);
  if (!changed) return;
  const facts = { reason: assessment.reason, work: 'spray', by: 'weather rules', readings: { at2m: reading.low, at10m: reading.high }, groundStationAlone: assessment.groundOnly, caughtByTwoHeights: assessment.caughtByTwoHeights };
  if (assessment.status === 'STOP') {
    holds.set(WEATHER_HOLD, { id: WEATHER_HOLD, jobTypes: ['spray'], fields: null, reason: assessment.reason, by: 'Weather Manager', since: fmtTime(sim.time) });
    trail('weather', 'executor', 'hold', `Spraying stopped. ${assessment.reason}${assessment.caughtByTwoHeights ? ' A ground station alone would have said Go.' : ''}`);
    discuss('hold', 'Spraying stopped by the weather', facts);
  } else if (holds.has(WEATHER_HOLD)) {
    holds.delete(WEATHER_HOLD);
    trail('weather', 'executor', 'hold-lifted', `Spraying may resume. ${assessment.reason}`);
    discuss('hold-lifted', 'Spraying may resume', facts);
  } else if (assessment.status === 'CAUTION') {
    trail('weather', 'operator', 'caution', assessment.reason);
  }
}

// ---- Scout drone (fully simulated, and labelled so everywhere). It looks at a tractor that has faulted,
// maps a field and reports on ground and crop, and can spot-spray small patches when the weather allows.
const drone = createDrone({ home: { e: 34, n: -6 } });
const droneReports = [], droneSprayed = [];
function droneScan(name, quiet = false) {
  const g = geom[name], f = scenario.fields.find(x => x.name === name);
  if (!g || !f) return false;
  drone.assign({ type: 'scan', field: { name, boundary: g.boundary, ground: GROUND_WORD[ground[name]], crop: ground[name] === 'stubble' ? (fieldRecord[name]?.crop || undefined) : undefined } });
  if (!quiet) trail('drone', 'operator', 'scan', `Drone sent to map ${name}.`);
  return true;
}
// While a tractor is spraying, the drone flies just behind it and steps through three heights, reading the wind
// at each. It leaves as soon as the pass stops (job done, hold, fault) or another drone mission is waiting.
let escort = null, droneWind = [], escortAfter = 0;
const LIMITS_WIND_MAX = 10;
function escortSprayer() {
  if (escort || sim.time < escortAfter) return;
  const u = units.find(x => { const t = x.twin, j = t.jobId && sim.jobs.get(t.jobId); return x.tel && !x.fault && t.status === 'ok' && t.action?.kind === 'work' && j?.type === 'spray' && x.place === j.fieldId && !heldBy(j); });
  if (!u) return;
  const jobId = u.twin.jobId;
  const still = () => { const t = u.twin, j = sim.jobs.get(jobId); return !u.fault && t.status === 'ok' && t.jobId === jobId && t.action?.kind === 'work' && j.status !== 'done' && !heldBy(j); };
  const id = drone.assign({ type: 'escort', subject: u.id, follow: () => (u.tel ? { e: u.tel.e, n: u.tel.n } : null), until: () => !still() });
  escort = { id, unit: u.id };
  trail('drone', 'weather', 'wind-watch', `${u.id} is spraying ${sim.label(sim.jobs.get(jobId))}: drone sent to fly above it and read the wind at 10, 30 and 50 m.`);
}

// ---- What is on each field now. The crop and its planting date come from the field's own record in AgOpenWeb
// (field.geojson); work done today comes from the job records AgOpenWeb writes as the tractors work. How far
// along the crop is comes from the last drone scan, and the margin on it widens the longer ago that was. With
// no scan at all it is worked out from the planting date alone, with a wide margin.
const SEASON_DAYS = { corn: 120, soybeans: 110, wheat: 110, hay: 60, alfalfa: 45, orchard: 200 };
const fieldRecord = {};
// What the farm remembers about each field between runs: the last survey of each field and when it was made.
const MEMORY_FILE = path.join(here, 'out', 'field-memory.json');
let lastScan = {};
try { lastScan = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')).surveys || {}; } catch { /* nothing remembered yet */ }
const remember = () => { try { fs.writeFileSync(MEMORY_FILE, JSON.stringify({ note: 'Last drone survey of each field. Delete this file to forget.', surveys: lastScan }, null, 1)); } catch { /* not fatal */ } };
const stageOf = (m) => (m >= 95 ? 'Ready' : m >= 75 ? 'Ripening' : m >= 45 ? 'Flowering and grain fill' : m >= 15 ? 'Leaf growth' : 'Emerging');
// Each field's record is a small file, crop-record.json, kept in that field's own AgOpenWeb folder next to its
// boundary. It says what is on the field (a growing crop, stubble after harvest, or plowed soil) and since when,
// and it is updated as work is finished, so the farm remembers between runs. The first time, the farm is given
// a mix: some fields growing, some harvested and waiting for the plow, some plowed and waiting for seed.
const dayStr = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
const daysSince = (d) => (d ? Math.max(0, Math.round((Date.now() - Date.parse(d)) / 86400000)) : null);
const recordFile = (name) => path.join(FIELDS_DIR, name, 'crop-record.json');
const saveRecord = (name) => { try { fs.writeFileSync(recordFile(name), JSON.stringify(fieldRecord[name], null, 1)); } catch { /* field folder missing */ } };
const START_MIX = ['growing', 'growing', 'growing', 'growing', 'harvested', 'harvested', 'harvested', 'plowed', 'plowed'];
for (let i = START_MIX.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [START_MIX[i], START_MIX[k]] = [START_MIX[k], START_MIX[i]]; }   // shuffled: used only for fields with no record yet
scenario.fields.forEach((f, i) => {
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(recordFile(f.name), 'utf8')); } catch { /* none yet */ }
  if (!rec) {
    let planted = null;
    try { planted = JSON.parse(fs.readFileSync(path.join(FIELDS_DIR, f.name, 'field.geojson'), 'utf8')).features.find(x => x.properties?.role === 'metadata')?.properties?.plantedOn || null; } catch { /* no field file */ }
    const state = START_MIX[i % START_MIX.length];
    rec = state === 'growing' ? { state, crop: f.crop || null, plantedOn: planted || dayStr(60) }
      : state === 'harvested' ? { state, crop: null, lastCrop: f.crop || null, nextCrop: f.crop || null, harvestedOn: dayStr(6 + (i * 5) % 13) }
        : { state, crop: null, lastCrop: f.crop || null, nextCrop: f.crop || null, plowedOn: dayStr(1 + (i * 3) % 5) };
    fieldRecord[f.name] = rec; saveRecord(f.name);
  }
  fieldRecord[f.name] = rec;
  ground[f.name] = rec.state === 'plowed' ? 'tilled' : rec.state === 'growing' && daysSince(rec.plantedOn) === 0 ? 'sown' : 'stubble';
});
// Work finished in a field changes its record.
function recordWork(name, type) {
  const rec = fieldRecord[name]; if (!rec) return;
  if (type === 'till') Object.assign(rec, { state: 'plowed', lastCrop: rec.crop || rec.lastCrop || null, nextCrop: rec.nextCrop || rec.crop || rec.lastCrop || null, crop: null, plowedOn: dayStr() });
  else if (type === 'mow') Object.assign(rec, { mowedOn: dayStr() });
  else if (type === 'seed') Object.assign(rec, { state: 'growing', crop: rec.nextCrop || rec.lastCrop || 'corn', plantedOn: dayStr(), cropPicked: false });
  else return;
  if (type === 'mow') delete lastScan[name];
  saveRecord(name);
}
let todaysWork = {}, todaysWorkAt = 0;
function readTodaysWork() {                       // job records from every tractor's AgOpenWeb copy, started this run
  if (Date.now() - todaysWorkAt < 5000) return todaysWork;
  todaysWorkAt = Date.now();
  const out = {};
  const root = path.resolve(FIELDS_DIR, '../../..');
  for (const u of units) {
    const port = Number(new URL(u.url).port) - 1000;
    for (const f of scenario.fields) {
      const dir = path.join(root, `data-${port}`, 'AgOpenWeb', 'Fields', f.name, 'jobs');
      let names = [];
      try { names = fs.readdirSync(dir).filter(n => n.startsWith(RUN)); } catch { continue; }
      for (const n of names) {
        try { const j = JSON.parse(fs.readFileSync(path.join(dir, n, 'job.json'), 'utf8')); (out[f.name] ||= []).push({ type: j.workType, startedAt: j.startedAt, ha: j.areaWorkedHectares || 0, tractor: u.id }); } catch { /* being written */ }
      }
    }
  }
  return (todaysWork = out);
}
const WORK_WORD = { till: 'Plowing', seed: 'Sowing', spray: 'Spraying', mow: 'Mowing' };
function fieldStatus() {
  const c = weather.current();
  const tempC = c ? c.reading.low.tempC : null;
  // No humidity sensor in the simulated mast: it is derived from the temperature (cool air near saturation, warm air drier).
  const humidityPct = tempC == null ? null : Math.round(Math.max(20, Math.min(95, 88 - (tempC - 8) * 3.2)));
  let growth = 1, why = 'good growing weather';
  if (tempC != null) {
    if (tempC < 18) { growth = Math.max(0.4, 1 - 0.035 * (18 - tempC)); why = 'cool'; }
    else if (tempC > 32) { growth = Math.max(0.5, 1 - 0.04 * (tempC - 32)); why = 'hot'; }
    if (humidityPct < 30) { growth -= 0.1; why = why === 'good growing weather' ? 'dry air' : why + ' and dry'; }
  }
  growth = +growth.toFixed(2);
  const conditionsText = tempC == null ? null : `${tempC.toFixed(0)} °C, ${humidityPct}% humidity: ${why}, crops growing at about ${Math.round(growth * 100)}% of their normal rate${humidityPct > 85 ? '; humid enough to watch for leaf disease' : ''}`;
  const work = readTodaysWork();
  return scenario.fields.map(f => fieldStatusOf(f, work, { tempC, humidityPct, growth, conditionsText })).map(x => ({ ...x, suggest: suggestFor(x) }));
}
function suggestFor(x) {
  if (x.queuedText) return null;
  if (x.ground === 'plowed') return { label: `Sow ${fieldRecord[x.name].nextCrop || fieldRecord[x.name].lastCrop || 'it'}`, steps: ['seed'] };
  if (!x.standing && x.ground === 'not plowed') return { label: 'Plow and sow', steps: ['till', 'seed'] };
  if (x.standing && x.pests > 0) return { label: 'Spray', steps: ['spray'] };
  if (x.standing && (x.crop === 'hay' || x.crop === 'alfalfa') && x.maturityPct >= 60) return { label: 'Mow', steps: ['mow'] };
  return null;
}
function fieldStatusOf(f, work, { tempC, humidityPct, growth, conditionsText }) {
  {
    const rec = fieldRecord[f.name], g = ground[f.name], crop = rec.crop, season = SEASON_DAYS[crop] || 100;
    const queued = backlog.filter(b => b.field === f.name && stillToDo(b)).map(b => ({ till: 'Plow', seed: 'Sow', spray: 'Spray', mow: 'Mow' }[b.type] || b.type));
    const todays = (work[f.name] || []).slice().sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const last = todays[todays.length - 1];
    const base = {
      name: f.name, acres: f.acres, crop, ground: GROUND_WORD[g], tempC, humidityPct, growthFactor: growth, conditionsText,
      queuedText: queued.length ? `${queued.join(', then ')} queued` : null,
      todayText: last ? `${WORK_WORD[last.type] || last.type} today by ${last.tractor}${last.ha ? `, ${last.ha.toFixed(2)} ha so far` : ''} (AgOpenGPS job record)` : null,
    };
    const want = rec.nextCrop || rec.lastCrop;
    if (g === 'tilled') { const d = daysSince(rec.plowedOn); return { ...base, crop: null, standing: false, cropChoice: rec.cropPicked ? rec.nextCrop : null, cropOptions: Object.keys(SEASON_DAYS), summaryText: queued.includes('Sow') ? `Tilled — sowing ${want || 'it'} is on the list` : rec.cropPicked ? `Tilled — needs sowing, ${rec.nextCrop} picked` : 'Tilled — needs sowing, pick a plant', statusText: `Bare soil, plowed ${d ? `${d} day${d > 1 ? 's' : ''} ago` : 'today'}`, stage: 'Plowed', nextText: queued.includes('Sow') ? 'Next: sowing is on the list' : `Next: sow${want ? ` ${want}` : ''}` }; }
    if (g === 'stubble' && !rec.crop) { const d = daysSince(rec.harvestedOn); return { ...base, crop: null, standing: false, summaryText: queued.length ? `Empty — ${queued.join(', then ').toLowerCase()} is on the list` : 'Empty — needs tilling', statusText: `Stubble${rec.lastCrop ? `: ${rec.lastCrop} harvested${d != null ? ` ${d} days ago` : ''}` : ''}`, stage: 'Harvested', nextText: queued.length ? `Next: ${queued.join(', then ').toLowerCase()} is on the list` : `Next: plow, then sow${want ? ` ${want}` : ''}` }; }
    if (g === 'sown') return { ...base, standing: true, plantedOn: new Date().toISOString().slice(0, 10), plantedDaysAgo: 0, plantedSource: 'AgOpenGPS job record, today', summaryText: `${crop ? crop[0].toUpperCase() + crop.slice(1) : 'Crop'} — sown today, estimated harvest in ${Math.round(season / growth)} days`, statusText: `Sown today${crop ? ` (${crop})` : ''}`,
      maturityPct: 0, marginPct: 0, harvestInDays: Math.round(season / growth), harvestMarginDays: Math.round(season * 0.1), harvestText: `Ready in about ${Math.round(season / growth)} days`, confidence: 'high', confidenceText: 'Just sown', stage: 'Sown', nextText: 'Next: first drone survey once it has emerged, in about two weeks' };
    const days = rec.plantedOn ? Math.max(0, Math.round((Date.now() - Date.parse(rec.plantedOn)) / 86400000)) : null;
    const sc = lastScan[f.name]?.ground === g || (lastScan[f.name] && lastScan[f.name].ground == null) ? lastScan[f.name] : null;
    let maturity, margin, confidence, confidenceText, scanAgeMin = null;
    if (sc) {
      scanAgeMin = Math.max(0, Math.round((Date.now() - sc.wall) / 1000 / SEC));      // in plan minutes, also across restarts
      maturity = sc.maturityPct;
      margin = Math.min(25, Math.round(2 + scanAgeMin / 20));                      // widens by a point every 20 plan minutes
      confidence = scanAgeMin < 90 ? 'high' : scanAgeMin < 240 ? 'medium' : 'low';
      confidenceText = `Drone scan ${scanAgeMin < 60 ? `${scanAgeMin} min` : `${(scanAgeMin / 60).toFixed(1)} h`} ago${confidence === 'low' ? ': scan again' : ''}`;
    } else {
      maturity = days == null ? null : Math.min(100, Math.round(days / season * 100));
      margin = 20; confidence = 'low';
      confidenceText = 'Never scanned: worked out from the planting date only';
    }
    const left = maturity == null ? null : Math.max(0, Math.round((100 - maturity) / 100 * season / growth));
    const leftMargin = Math.max(1, Math.round(margin / 100 * season));
    const when = left == null ? null : new Date(Date.now() + left * 86400000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const ready = maturity != null && maturity >= 95;
    const cut = crop === 'hay' || crop === 'alfalfa' ? 'cut' : 'harvest';
    const pests = sc?.pests || 0;
    const nextText = !sc ? `Next: drone survey. ${days != null ? `Planted ${days} days ago and never` : 'Never'} surveyed`
      : pests ? `Next: spot-spray ${pests} pest patch(es)${holds.has(WEATHER_HOLD) ? ' when spraying is allowed' : ''}`
      : ready ? `Next: ${cut} now`
      : sc.waterStress ? 'Next: irrigate, the thermal camera shows water stress'
      : confidence === 'low' ? 'Next: drone survey, the last one is out of date'
      : `Next: ${cut} around ${when}; survey again before then`;
    return { ...base, standing: true, plantedOn: rec.plantedOn, plantedDaysAgo: days, plantedSource: 'AgOpenGPS field record', stage: maturity == null ? null : stageOf(maturity), nextText,
      summaryText: `${crop[0].toUpperCase()}${crop.slice(1)} — ${maturity == null ? 'needs a survey' : ready ? `ready to ${cut} now` : `estimated ${cut === 'cut' ? 'cut' : 'harvest'} in ${left} days`}`,
      statusText: `${crop[0].toUpperCase()}${crop.slice(1)}${days != null ? `, planted ${days} days ago` : ''}`,
      maturityPct: maturity, marginPct: margin, harvestInDays: ready ? 0 : left, harvestMarginDays: leftMargin, harvestDate: when,
      harvestText: maturity == null ? null : ready ? `Ready to ${cut} now` : `Ready to ${cut} in about ${left} days (${when}, give or take ${leftMargin})`,
      problems: sc?.problems || [], problemsText: sc?.problems?.length ? sc.problems.map(p => p.text).join('; ') : null,
      standPct: sc?.standPct ?? null, moisturePct: sc?.moisturePct ?? null, pests: sc?.pests ?? null, canopyM: sc?.canopyM ?? null, canopyDeltaC: sc?.canopyDeltaC ?? null, waterStress: sc?.waterStress ?? null,
      sensorsText: sc && sc.canopyM != null ? `LiDAR canopy ${sc.canopyM} m · thermal ${Math.abs(sc.canopyDeltaC)} °C ${sc.canopyDeltaC > 0 ? 'warmer' : 'cooler'} than air${sc.waterStress ? ' (water stress)' : ''} · soil moisture ${sc.moisturePct}%` : null,
      lastScanClock: sc?.clock ?? null, scanAgeMin, confidence, confidenceText };
  }
}

// ---- Crop manager. Every so often it goes through the fields: where is each crop in its life, when was it last
// looked at, what needs doing. A standing crop that has never been surveyed, or not for a long while, gets the
// drone; the survey says how far along it is and whether it needs spraying.
const surveying = new Set();
const SURVEY_STALE_MIN = 240;                      // plan minutes after which a survey is out of date
let cropReviewAt = 4;
function cropManager() {
  if (mode !== 'running' || sim.time < cropReviewAt) return;
  const d = drone.state();
  if (d.mission || d.queue || d.batteryPct < 40) return;          // the drone is busy or low: look again next minute
  cropReviewAt = sim.time + 20;
  const due = fieldStatus().filter(f => f.standing && f.plantedDaysAgo !== 0 && !surveying.has(f.name) && (f.scanAgeMin == null || f.scanAgeMin > SURVEY_STALE_MIN))
    .sort((a, b) => (b.scanAgeMin ?? 1e9) - (a.scanAgeMin ?? 1e9) || (b.maturityPct ?? 0) - (a.maturityPct ?? 0))[0];
  if (!due) return;
  surveying.add(due.name);
  const seen = due.scanAgeMin == null ? 'has never been surveyed' : `was last surveyed ${(due.scanAgeMin / 60).toFixed(1)} h ago`;
  trail('crop-manager', 'drone', 'survey', `Field review, ${due.name}: ${due.crop} planted ${due.plantedDaysAgo ?? '?'} days ago, about ${due.maturityPct}% along (give or take ${due.marginPct}), and it ${seen}. Sending the drone to see how far along it is and whether it needs spraying.`, { field: due.name });
  droneScan(due.name);
}

// ---- "Let the AI drive". Off, the operator builds the job list. On, the crop manager reads every field's record,
// puts the work each one needs on the list (stubble: plow then sow; plowed soil: sow), and starts the day. Surveys
// and spot-spraying follow from the field reviews above. The operator can still add or remove jobs.
const AI_FILE = path.join(here, 'out', 'ai-drive.json');
let aiDrive = false, aiAt = 0;
try { aiDrive = !!JSON.parse(fs.readFileSync(AI_FILE, 'utf8')).on; } catch { /* off */ }
function setAiDrive(on) {
  aiDrive = !!on;
  try { fs.writeFileSync(AI_FILE, JSON.stringify({ on: aiDrive })); } catch { /* not fatal */ }
  trail('operator', 'crop-manager', 'ai-drive', aiDrive ? 'Let the AI drive: on. The crop manager will queue the work each field needs.' : 'AI drive off. The operator builds the job list.');
  aiAt = 0;
  if (aiDrive) {
    const order = scenario.fields.slice().sort((p, q) => laneLen('depot', p.id) - laneLen('depot', q.id)).filter(f => !surveying.has(f.name));
    for (const f of order) { surveying.add(f.name); droneScan(f.name, true); }
    if (order.length) trail('crop-manager', 'drone', 'survey', `First, a fresh look at every field. Drone surveying all ${order.length}, nearest first: ${order.map(f => f.name).join(', ')}. The plan is updated as each survey comes in.`, { fields: order.map(f => f.name) });
    aiPlan();
  }
}
function aiPlan() {
  if (!aiDrive || (mode === 'running' && sim.time < aiAt)) return;
  aiAt = sim.time + 10;
  // Only as much as fits in the day: sowing the fields that are already plowed comes first, then the stubble
  // fields nearest the yard, and no more than five jobs open at a time. The rest wait for the next review.
  const added = [], waiting = [];
  const need = scenario.fields.map(f => ({ f, rec: fieldRecord[f.name], g: ground[f.name] }))
    .filter(x => !backlog.some(b => b.field === x.f.name && stillToDo(b)))
    .map(x => ({ ...x, steps: x.g === 'tilled' ? ['seed'] : x.g === 'stubble' && !x.rec.crop ? ['till', 'seed'] : x.g === 'stubble' && (x.rec.crop === 'hay' || x.rec.crop === 'alfalfa') && x.rec.mowedOn !== dayStr() && lastScan[x.f.name]?.ground === 'stubble' && lastScan[x.f.name].maturityPct >= 60 ? ['mow'] : null }))
    .filter(x => x.steps)
    .sort((p, q) => p.steps.length - q.steps.length || laneLen('depot', p.f.id) - laneLen('depot', q.f.id));
  let open = backlog.filter(stillToDo).length;
  for (const { f, rec, steps } of need) {
    if (open + steps.length > 5) { waiting.push(f.name); continue; }
    try {
      draftJobs({ fields: [f.name], steps, priority: 'medium', deadline: '17:00' });
      open += steps.length;
      added.push(steps[0] === 'mow' ? `${f.name}: the survey shows the ${rec.crop} ${lastScan[f.name].maturityPct}% along, ready for a cut: mow` : steps.length === 2 ? `${f.name} is stubble after ${rec.lastCrop || 'the last crop'}: plow, then sow ${rec.nextCrop || rec.lastCrop || 'it'}` : `${f.name} is plowed and waiting: sow ${rec.nextCrop || rec.lastCrop || 'it'}`);
    } catch (err) { /* the list rules refused it; leave it to the operator */ }
  }
  if (added.length) trail('crop-manager', 'planner', 'ai-plan', `Field review. ${added.join('. ')}.${waiting.length ? ` ${waiting.join(' and ')} also need${waiting.length === 1 ? 's' : ''} work; ${waiting.length === 1 ? 'it waits' : 'they wait'} until there is room in the day.` : ''} Growing fields are left alone and surveyed by drone.`, { added: added.length, waiting });
  if (mode === 'building' && backlog.length) { try { startDay(); } catch { /* already running */ } }
}

// ---- The farm assistant (chat). Its tools are the same functions the dashboard's buttons call.
const fieldByName = (name) => scenario.fields.find(f => f.name.toLowerCase() === String(name || '').toLowerCase().trim()) || scenario.fields.find(f => f.name.toLowerCase().includes(String(name || '').toLowerCase().trim()) && String(name || '').trim().length > 2);
const STEP_WORD = { till: 'plow', seed: 'sow', spray: 'spray', mow: 'mow' };
const chat = createChat({
  clock: () => fmtTime(sim.time),
  context: () => `plan clock ${fmtTime(sim.time)}; the day is ${mode === 'running' ? 'running' : 'not started (the job list is being built)'}; AI drive is ${aiDrive ? 'on' : 'off'}; fields: ${scenario.fields.map(f => f.name).join(', ')}; tractors: ${units.map(u => u.id).join(', ')}.`,
  tools: [
    { name: 'farm_overview', description: 'The whole farm now: clock, tractors (state, task, fuel, implement), jobs (id, what, status, tractor, progress, deadline), tasks waiting for a person at the depot, spray conditions, the latest plan change with its reasons, and a one-line status of every field.',
      input_schema: { type: 'object', properties: {} },
      handler: async () => { const st = snapshot(); const lp = st.trail.find(m => m.type === 'plan'); return { clock: st.clock, day: mode, aiDrive, tractors: st.tractors.map(t => ({ id: t.id, state: t.state.text, task: t.task, fuelPct: t.fuelPct, implement: t.mounted, eta: t.eta ? { jobFinishes: t.eta.jobDoneAt, fuelToReserveAt: t.eta.fuelToReserveAt } : undefined })), jobs: st.jobs, waitingForAPerson: st.tasks.filter(k => k.state !== 'done').map(k => k.text), spray: st.weather ? { status: st.weather.status, reason: st.weather.reason } : null, latestPlanChange: lp ? { at: lp.clock, text: lp.text, reasons: lp.lines || [] } : null, fields: st.fields.map(f => ({ name: f.name, status: f.summaryText, next: f.nextText, queued: f.queuedText })) }; } },
    { name: 'field_report', description: 'Everything known about one field: what is on it, when it was planted, how far along it is and how sure that is, when it should be ready, stand, soil moisture, pests, weather effect, work queued. With send_drone true the drone also flies there for a fresh survey and its camera is shown to the operator.',
      input_schema: { type: 'object', properties: { field: { type: 'string' }, send_drone: { type: 'boolean' } }, required: ['field'] },
      handler: async ({ field, send_drone }) => { const f = fieldByName(field); if (!f) throw new Error(`No field called "${field}". Fields: ${scenario.fields.map(x => x.name).join(', ')}.`); const r = fieldStatus().find(x => x.name === f.name); const sent = send_drone ? droneScan(f.name) : false; return { ...r, droneSent: !!sent }; },
      summary: ({ send_drone }, out) => (send_drone && out?.droneSent ? `Sent the drone to ${out.name} for a fresh look` : null),
      drone: ({ send_drone }, out) => (send_drone && out?.droneSent ? { field: out.name } : null) },
    { name: 'add_jobs', description: 'Put work on the job list for one or more fields. steps is an ordered list from: till (plow), seed (sow), spray, mow. The list rules may refuse (for example sowing before plowing); the reason is returned.',
      input_schema: { type: 'object', properties: { fields: { type: 'array', items: { type: 'string' } }, steps: { type: 'array', items: { type: 'string', enum: ['till', 'seed', 'spray', 'mow'] } }, priority: { type: 'string', enum: ['high', 'medium', 'low'] }, deadline: { type: 'string', description: 'HH:MM today, default 17:00' } }, required: ['fields', 'steps'] },
      handler: async ({ fields, steps, priority, deadline }) => { const names = fields.map(n => { const f = fieldByName(n); if (!f) throw new Error(`No field called "${n}".`); return f.name; }); const ids = draftJobs({ fields: names, steps, priority: priority || 'medium', deadline: deadline || '17:00' }); enforcePriorities(); return { added: ids, dayRunning: mode === 'running', note: mode === 'running' ? 'The planner is fitting them in now.' : 'The day has not started; call start_day when the list is ready.' }; },
      summary: ({ fields, steps }, out) => `Added ${out.added.length} job(s): ${steps.map(x => STEP_WORD[x] || x).join(' then ')} on ${fields.join(', ')}` },
    { name: 'remove_job', description: 'Take a job off the list (only jobs not yet sent to the planner, and any job that waits for it).', input_schema: { type: 'object', properties: { job: { type: 'string' } }, required: ['job'] },
      handler: async ({ job }) => { removeDraft(job); return `Removed ${job}.`; }, summary: ({ job }) => `Removed job ${job}` },
    { name: 'start_day', description: 'Start the day: send the job list to the planner and the tractors.', input_schema: { type: 'object', properties: {} },
      handler: async () => { startDay(); return 'The day has started.'; }, summary: () => 'Started the day' },
    { name: 'why_job', description: 'Why a job is with its tractor and when it will finish, with the alternatives the planner rejected. Needs the job id (for example N3).', input_schema: { type: 'object', properties: { job: { type: 'string' } }, required: ['job'] },
      handler: async ({ job }) => [].concat(sim.dispatcher.why(sim, job)) },
    { name: 'change_priority', description: 'Change a job\'s priority so the planner brings it forward or pushes it back. The planner re-plans at once.', input_schema: { type: 'object', properties: { job: { type: 'string' }, priority: { type: 'string', enum: ['high', 'medium', 'low'] }, reason: { type: 'string' } }, required: ['job', 'priority'] },
      handler: async ({ job, priority }) => { const r = setPriority(job, priority); return `${job} is now ${priority} priority.${r.note ? ' ' + r.note + '.' : ''}`; },
      summary: ({ job, priority }) => `Changed ${job} to ${priority} priority` },
    { name: 'set_ai_drive', description: 'Switch "Let the AI drive" on or off. On: the crop manager queues the plowing and sowing each field needs and starts the day.', input_schema: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] },
      handler: async ({ on }) => { setAiDrive(on); return `AI drive is ${aiDrive ? 'on' : 'off'}.`; }, summary: ({ on }) => `Switched AI drive ${on ? 'on' : 'off'}` },
    { name: 'pick_crop', description: 'Choose the crop to sow next on a plowed field (corn, soybeans, wheat, hay, alfalfa, orchard).', input_schema: { type: 'object', properties: { field: { type: 'string' }, crop: { type: 'string' } }, required: ['field', 'crop'] },
      handler: async ({ field, crop }) => { const f = fieldByName(field), c = String(crop).toLowerCase(); if (!f) throw new Error(`No field called "${field}".`); if (!SEASON_DAYS[c]) throw new Error(`Unknown crop: ${crop}.`); Object.assign(fieldRecord[f.name], { nextCrop: c, cropPicked: true }); saveRecord(f.name); return `${f.name} will be sown with ${c}.`; },
      summary: ({ field, crop }) => `Picked ${crop} for ${field}` },
  ],
  // Without the model: a field named in the question still gets its report and the drone.
  fallback: (text, actions, state) => {
    const f = scenario.fields.find(x => text.toLowerCase().includes(x.name.toLowerCase()));
    if (!f) return null;
    const r = fieldStatus().find(x => x.name === f.name);
    if (droneScan(f.name)) { actions.push({ tool: 'field_report', summary: `Sent the drone to ${f.name} for a fresh look` }); state.drone = { field: f.name }; }
    return `${f.name}: ${r.summaryText}. ${r.confidenceText || ''} ${r.nextText || ''} The drone is on its way; its camera is below. (Answered from the records without the language model, which could not be reached.)`.replace(/\s+/g, ' ');
  },
});

// ---- The day's plan as the operator sees it: every task ranked by urgency, and each tractor's schedule.
const RANK = { low: 0, medium: 1, high: 2 };
const STEP_NAME = { till: 'Plow', seed: 'Sow', spray: 'Spray', mow: 'Mow' };
const prioOf = (id) => sim.jobs.get(id)?.priority || backlog.find(b => b.id === id)?.priority || 'medium';
function applyPriority(id, priority, changed) {
  if (prioOf(id) === priority) return;
  const b = backlog.find(x => x.id === id), j = sim.jobs.get(id);
  if (b) b.priority = priority;
  if (j && j.status !== 'done') sim.inject({ type: 'priority_change', job: id, priority, note: 'job planner', source: 'operator', signal: 'Job planner' });
  changed.push({ job: id, priority });
}
// A job that must happen first is always at least as urgent as the job that waits for it: sowing can never
// outrank the plowing it depends on. Raising a later step raises the earlier one; lowering an earlier step
// lowers what follows it.
function setPriority(id, priority) {
  if (!(priority in RANK)) throw new Error(`Unknown priority: ${priority}`);
  if (!backlog.some(b => b.id === id) && !sim.jobs.get(id)) throw new Error(`No job ${id}.`);
  const changed = [], notes = [];
  applyPriority(id, priority, changed);
  for (let up = backlog.find(x => x.id === id)?.waitsFor; up; up = backlog.find(x => x.id === up)?.waitsFor) {
    if (RANK[prioOf(up)] < RANK[priority] && sim.jobs.get(up)?.status !== 'done') { applyPriority(up, priority, changed); notes.push(`${up} raised to ${priority} as well: it has to be done first, so it must be at least as urgent`); }
  }
  const down = (pid) => backlog.filter(x => x.waitsFor === pid).forEach(d => { if (RANK[prioOf(d.id)] > RANK[priority]) { applyPriority(d.id, priority, changed); notes.push(`${d.id} lowered to ${priority} as well: it cannot be more urgent than the job it waits for`); } down(d.id); });
  down(id);
  if (changed.length) trail('operator', 'planner', 'priority', `${id} set to ${priority} priority.${notes.length ? ' ' + notes.join('. ') + '.' : ''}`, { changed });
  return { changed, note: notes.join('. ') || null };
}
function enforcePriorities() {                      // after jobs are added: the same rule over the whole list
  for (const b of backlog) if (b.waitsFor && stillToDo(b) && RANK[prioOf(b.id)] > RANK[prioOf(b.waitsFor)] && sim.jobs.get(b.waitsFor)?.status !== 'done') applyPriority(b.waitsFor, prioOf(b.id), []);
}
function planView() {
  const plan = sim.dispatcher.plan || {};
  const tractorOf = (id) => Object.keys(plan.assign || {}).find(t => (plan.assign[t] || []).some(x => (x?.id ?? x) === id)) || null;
  const tasks = backlog.map(b => {
    const j = sim.jobs.get(b.id), sc = plan.schedule?.[b.id], r = routes.get(b.id);
    if (j?.status === 'cancelled') return null;
    return {
      id: b.id, step: STEP_NAME[b.type] || b.type, field: b.field, label: `${STEP_NAME[b.type] || b.type} ${b.field}`, type: b.type,
      priority: prioOf(b.id), deadline: fmtTime(j?.deadline ?? b.deadline), status: j ? j.status : b.status === 'waiting' ? 'waiting' : 'draft',
      tractor: j?.status === 'done' ? (j.doneBy || null) : tractorOf(b.id), start: sc ? fmtTime(sc.start) : null,
      end: j?.status === 'done' ? fmtTime(j.doneAt) : sc ? fmtTime(sc.end) : null, late: !!sc?.late && j?.status !== 'done',
      pct: j?.status === 'done' ? 100 : r ? Math.round(r.fraction * 100) : null, after: b.waitsFor || null,
    };
  }).filter(Boolean).sort((a, b) => (a.status === 'done') - (b.status === 'done') || RANK[b.priority] - RANK[a.priority] || a.deadline.localeCompare(b.deadline) || (a.end || '99').localeCompare(b.end || '99'));
  const schedule = units.map(u => ({
    tractor: u.id, name: u.twin.name,
    items: (plan.evals?.[u.id]?.legs || []).filter(l => l.end > l.start).map(l => ({ kind: l.kind, job: l.jobId || null, type: l.jobId ? sim.jobs.get(l.jobId)?.type : null, label: l.jobId && sim.jobs.get(l.jobId) ? sim.label(sim.jobs.get(l.jobId)) : l.kind === 'swap' ? `change to ${l.impl || 'implement'}` : l.kind, startMin: Math.round(l.start), endMin: Math.round(l.end), start: fmtTime(l.start), end: fmtTime(l.end) })),
  }));
  return { tasks, schedule, nowMin: sim.time, now: fmtTime(sim.time), dayEndMin: 660 };
}

function droneTick(dt) {
  escortSprayer();
  for (const ev of drone.tick(dt)) {
    if (ev.type === 'report') {
      const r = ev.report;
      droneReports.push({ clock: fmtTime(sim.time), ...r });
      if (droneReports.length > 12) droneReports.shift();
      if (r.kind === 'fault-inspection') {
        trail('drone', 'fault-manager', 'inspection', `Simulated drone view of ${r.subject}: ${r.assessment} Recommends: ${r.recommend}.`);
        discuss('fault', `Drone inspection of ${r.subject}`, { tractor: r.subject, kind: r.symptom, signal: 'drone inspection (simulated)', droneFindings: r.findings, droneAssessment: r.assessment, droneRecommends: r.recommend });
      } else if (r.kind === 'field-scan') {
        const cropNow = fieldRecord[r.field]?.crop, topM = { corn: 2.2, soybeans: 0.6, wheat: 0.9, hay: 0.4, alfalfa: 0.4, orchard: 3.5 }[cropNow] || 0;
        const airC = weather.current()?.reading.low.tempC ?? 15;
        // LiDAR gives the canopy height; the thermal camera gives the canopy temperature against the air. A canopy
        // warmer than the air is short of water (it has stopped cooling itself); dry soil pushes it that way.
        const canopyM = ground[r.field] === 'stubble' && cropNow ? +(topM * Math.min(1, 0.25 + r.maturityPct / 100 * 0.8)).toFixed(2) : 0;
        const canopyDeltaC = canopyM ? +(((22 - r.moisturePct) / 6) - 1.2).toFixed(1) : null;
        // Problem areas for the heatmap: the pest patches the camera found, plus patches where the crop is behind
        // (shorter in the LiDAR, warmer in the thermal picture), each with a likely cause. Simulated, and fixed per field.
        const problems = (r.pests || []).map(p => ({ e: +p.e.toFixed(1), n: +p.n.toFixed(1), radiusM: p.radiusM, kind: 'pests', severity: p.severity || 'medium', text: `Pests, ${p.severity || 'medium'}` }));
        if (canopyM) {
          const gb = geom[r.field]?.boundary || [];
          const e0 = Math.min(...gb.map(p => p.e)), e1 = Math.max(...gb.map(p => p.e)), n0 = Math.min(...gb.map(p => p.n)), n1 = Math.max(...gb.map(p => p.n));
          let hsh = 7; for (const ch of r.field) hsh = (hsh * 33 + ch.charCodeAt(0)) % 100003;
          const rnd = () => { hsh = (hsh * 1103515245 + 12345) % 2147483648; return hsh / 2147483648; };
          const causes = ['waterlogged low spot', 'compacted ground', 'short of nitrogen', 'thin stand after a planter skip'];
          for (let k = 0, nP = 1 + Math.floor(rnd() * 2); k < nP && gb.length; k++) {
            const behind = Math.round(15 + rnd() * 25), cause = causes[Math.floor(rnd() * causes.length)];
            problems.push({ e: +(e0 + (0.2 + rnd() * 0.6) * (e1 - e0)).toFixed(1), n: +(n0 + (0.2 + rnd() * 0.6) * (n1 - n0)).toFixed(1), radiusM: Math.round(9 + rnd() * 9), kind: 'poor growth', severity: behind > 28 ? 'high' : 'medium', text: `Crop ${behind}% behind the rest of the field: likely ${cause}` });
          }
        }
        lastScan[r.field] = { problems, wall: Date.now(), clock: fmtTime(sim.time), ground: ground[r.field], maturityPct: r.maturityPct, standPct: r.standPct, moisturePct: r.moisturePct, pests: (r.pests || []).length, weedsPct: r.weedsPct ?? null, canopyM, canopyDeltaC, canopyC: canopyDeltaC == null ? null : +(airC + canopyDeltaC).toFixed(1), waterStress: canopyDeltaC != null && canopyDeltaC > 0.8 };
        remember();
        surveying.delete(r.field);
        const fs1 = fieldStatus().find(x => x.name === r.field);
        const ls = lastScan[r.field];
        if (fs1?.standing && fs1.maturityPct != null) trail('crop-manager', 'operator', 'field-review', `${r.field} after the survey. Camera: ${fs1.crop}, ${fs1.maturityPct}% along (${fs1.stage.toLowerCase()}), ${fs1.standPct}% stand${fs1.pests ? `, ${fs1.pests} pest patch(es)` : ', no pests seen'}. LiDAR: canopy ${ls.canopyM} m. Thermal: canopy ${Math.abs(ls.canopyDeltaC)} °C ${ls.canopyDeltaC > 0 ? 'warmer' : 'cooler'} than the air${ls.waterStress ? ', a sign of water stress' : ', no water stress'}; soil moisture ${fs1.moisturePct}%.${ls.problems.filter(p => p.kind === 'poor growth').length ? ` Problem areas on the heatmap: ${ls.problems.filter(p => p.kind === 'poor growth').map(p => p.text.toLowerCase()).join('; ')}.` : ''} ${fs1.nextText}.`, { field: r.field });
        else if (fs1) trail('crop-manager', 'operator', 'field-review', `${r.field} after the survey: ${fs1.summaryText.toLowerCase()}; soil moisture ${ls.moisturePct}%${ls.weedsPct ? `, weeds on ${ls.weedsPct}% of it` : ''}, ${ls.moisturePct < 32 ? 'firm enough for machines' : 'too wet for machines today'}. ${fs1.nextText || ''}`, { field: r.field });
        trail('drone', 'operator', 'field-report', r.summary);
        discuss('replan', `Drone scan of ${r.field}`, { field: r.field, scan: { ground: r.ground, moisturePct: r.moisturePct, trafficable: r.trafficable, standPct: r.standPct, maturityPct: r.maturityPct, harvestReady: r.harvestReady, pestSpots: r.pests.length, weedsPct: r.weedsPct, recommend: r.recommend } });
        const wants = (r.recommend || []).find(x => x.action === 'spot-spray');
        if (wants && r.pests.length) {
          if (holds.has(WEATHER_HOLD)) trail('drone', 'operator', 'waiting', `${r.field} has ${r.pests.length} pest patch(es) to spot-spray, but spraying is on hold for weather. The drone will not spray now.`);
          else { drone.assign({ type: 'spot-spray', field: r.field, spots: r.pests.map(p => ({ e: p.e, n: p.n, radiusM: p.radiusM })) }); trail('drone', 'operator', 'spot-spray', `Drone spot-spraying ${r.pests.length} pest patch(es) in ${r.field} instead of sending the 24 m sprayer.`); }
        }
      }
    } else if (ev.type === 'escort-ended') {
      if (escort?.id === ev.missionId) { escort = null; escortAfter = sim.time + 30; }      // then leave the drone to its surveys for half a plan hour
    } else if (ev.type === 'wind-sample') {
      // Wind at the drone's height, from the same simulated air as the mast readings at 2 m and 10 m
      // (a power-law profile through those two), with a little gust noise.
      const c = weather.current();
      if (c) {
        const lo = c.reading.low, hi = c.reading.high;
        const alpha = lo.windMph > 0.2 && hi.windMph > 0.2 ? Math.log(hi.windMph / lo.windMph) / Math.log(hi.heightM / lo.heightM) : 0.15;
        const mph = Math.max(0, lo.windMph * Math.pow(ev.altM / lo.heightM, Math.max(-0.2, Math.min(0.5, alpha))) + (Math.random() - 0.5) * 0.6);
        // Air temperature at that height: the mast's gradient between 2 m and 10 m carried upward, easing off with
        // height. Warmer air above cooler air is an inversion, which keeps spray droplets hanging near the ground.
        const grad = (hi.tempC - lo.tempC) / (hi.heightM - lo.heightM);
        const tempC = lo.tempC + grad * (hi.heightM - lo.heightM) * Math.log(ev.altM / lo.heightM) / Math.log(hi.heightM / lo.heightM) + (Math.random() - 0.5) * 0.1;
        droneWind = droneWind.filter(w => w.altM !== ev.altM).concat({ altM: ev.altM, mph: +mph.toFixed(1), tempC: +tempC.toFixed(1), clock: fmtTime(sim.time), over: ev.subject }).sort((a, b) => a.altM - b.altM);
        if (ev.lastOfCycle && sim.time - (escort?.said ?? -99) >= 20) {
          if (escort) escort.said = sim.time;
          const top = droneWind[droneWind.length - 1];
          const warmAloft = top.tempC != null && top.tempC - lo.tempC > 0.3;
          trail('drone', 'weather', 'wind-profile', `Drone above ${ev.subject} while it sprays: ${droneWind.map(w => `${w.altM} m: ${w.mph} mph, ${w.tempC} °C`).join('; ')} (mast at ${lo.heightM} m: ${lo.windMph} mph, ${lo.tempC} °C).${warmAloft ? ` The air is ${(top.tempC - lo.tempC).toFixed(1)} °C warmer at ${top.altM} m than at the ground: an inversion, spray would hang and drift.` : ' Temperature falls with height: no inversion.'}${top.mph > LIMITS_WIND_MAX ? ` Above the ${LIMITS_WIND_MAX} mph limit aloft: watch for drift if it mixes down.` : ''}`, { profile: droneWind });
        }
      }
    } else if (ev.type === 'sprayed') {
      droneSprayed.push({ field: ev.field, ...ev.spot });
    }
  }
}

function command(line) {
  const [verb, id, mode] = line.trim().split(/\s+/);
  const u = units.find(x => x.id === id);
  if (verb === 'quit') return finish('operator quit');
  if (!u) return console.log('commands: break T1 | repair T1 | fault T2 stuck|dead|ok | quit');
  if (verb === 'break') sim.inject({ type: 'breakdown', tractor: id, note: 'reported by operator', source: 'operator', signal: 'operator report' });
  else if (verb === 'repair') clear(u, 'cleared by operator');
  else if (verb === 'fault') { trail('test', u.id, 'inject', `fault ${mode}`); fetch(`${u.url}/fault/${mode}`, { method: 'POST' }).catch(() => {}); }
}
// Typed commands are a convenience. After Start over the fresh copy no longer owns the Terminal's keyboard and
// reading it fails; that must not stop the coordinator, so the error is swallowed and typing simply stops working.
process.stdin.on('error', () => {});
try { readline.createInterface({ input: process.stdin }).on('line', command).on('error', () => {}); } catch { /* no keyboard: page and API only */ }
process.on('uncaughtException', (err) => { if (err?.code === 'EIO' || err?.syscall === 'read') return; console.error(err); process.exit(1); });

function status() {
  console.log('           ' + units.map(u => {
    const w = world(u.twin), lag = u.tel ? Math.round(Math.hypot(w.e - u.tel.e, w.n - u.tel.n)) : '?';
    return `${u.id} ${u.twin.status === 'ok' ? (u.twin.action?.kind || 'idle') : 'DOWN'} real(${u.tel ? `${Math.round(u.tel.e)},${Math.round(u.tel.n)} ${u.tel.speedKph}km/h` : 'no telemetry'}) plan-gap ${lag}m`;
  }).join(' | '));
}

let stopped = false;
function finish(why) {
  if (stopped) return; stopped = true;
  for (const u of units) call(u, 'POST', '/command', { type: 'stop', label: 'run ended' }).catch(() => {});
  const m = sim.metrics();
  fs.writeFileSync(path.join(here, 'out', 'live_metrics.json'), JSON.stringify(m, null, 1));
  console.log(`\nRun ended (${why}) at ${fmtTime(sim.time)}. Trail: agopen/out/trail.jsonl`);
  setTimeout(() => process.exit(0), 400);
}

// ---- Roundtable. The rules above have already acted, in milliseconds. Here the managers talk it through
// where the operator can see it, and the Plan Manager may make the judgement calls through its tools.
// None of this can delay a tractor: discussions run on their own, and a slow or missing model just means
// a rule-written line appears instead.
const roundLines = [];
const fleetFacts = () => units.map(u => ({ id: u.id, state: stateOf(u).text, task: u.cmd?.label || '', implement: u.twin.mounted, fuelPct: Math.round(100 * u.twin.fuel / u.twin.fuelCapacity) }));
const jobFacts = () => [...sim.jobs.values()].filter(j => j.status !== 'done' && j.status !== 'cancelled').map(j => ({ id: j.id, label: sim.label(j), priority: j.priority, deadline: fmtTime(j.deadline), workedPct: Math.round(100 * (routes.get(j.id)?.fraction ?? 0)) }));
const rt = createRoundtable({
  say: (line) => {
    if (!rtTitles.has(line.topicId)) rtTitles.set(line.topicId, rtPending.shift() || '');   // discussions run one at a time, in order
    roundLines.push({ ...line, agent: line.role || line.agent, topic: rtTitles.get(line.topicId), clock: fmtTime(sim.time) });
    if (roundLines.length > 120) roundLines.shift();
  },
  tools: {
    change_priority: {
      description: 'Change a job\'s priority (high, medium or low) so the planner brings it forward or pushes it back.',
      input_schema: { type: 'object', properties: { job: { type: 'string' }, priority: { type: 'string', enum: ['high', 'medium', 'low'] }, reason: { type: 'string' } }, required: ['job', 'priority', 'reason'] },
      handler: async ({ job, priority, reason }) => { if (!sim.jobs.get(job)) return `No job ${job}.`; sim.inject({ type: 'priority_change', job, priority, note: reason, source: 'plan-manager', signal: 'Plan Manager decision' }); return `${job} is now ${priority} priority.`; },
    },
    approve_late: {
      description: 'Accept that a job will finish after its deadline, so the planner keeps it in today\'s plan.',
      input_schema: { type: 'object', properties: { job: { type: 'string' }, reason: { type: 'string' } }, required: ['job', 'reason'] },
      handler: async ({ job, reason }) => { if (!sim.jobs.get(job)) return `No job ${job}.`; sim.inject({ type: 'priority_change', job, allowLate: true, note: reason, source: 'plan-manager', signal: 'Plan Manager decision' }); return `${job} may finish late.`; },
    },
    defer_job: {
      description: 'Take a job out of today\'s plan and leave it for tomorrow. Use only when it cannot be done today.',
      input_schema: { type: 'object', properties: { job: { type: 'string' }, reason: { type: 'string' } }, required: ['job', 'reason'] },
      handler: async ({ job, reason }) => { if (!sim.jobs.get(job)) return `No job ${job}.`; sim.inject({ type: 'cancel_job', job, note: reason, source: 'plan-manager', signal: 'Plan Manager decision' }); return `${job} deferred to tomorrow.`; },
    },
  },
});
const rtTitles = new Map(), rtPending = [];
function discuss(type, title, facts) {
  rtPending.push(title);
  const full = { clock: fmtTime(sim.time), ...facts, fleet: fleetFacts(), openJobs: jobFacts() };
  rt.convene({ type, title, facts: full }).catch(() => {});
}
// Turn the planner's own log into topics for the table.
sim.listeners.push((e) => {
  if (e.type === 'plan') {
    const lines = (e.lines || []).slice(0, 6);
    const lf = lastFault;
    if (/broke down/i.test(e.text) && lf) discuss('fault', `${lf.tractor} out of service`, { tractor: lf.tractor, kind: lf.kind, signal: lf.signal, plan: e.text, changes: lines });
    else if (/back in service/i.test(e.text)) discuss('recovered', e.text, { tractor: (e.text.match(/T\d+/) || [''])[0], plan: e.text, changes: lines });
    else if (/new job/i.test(e.text)) discuss(sim.time < 2 ? 'day-start' : 'new-jobs', e.text, { plan: e.text, changes: lines });
  } else if (e.type === 'done') {
    discuss('job-done', e.text, { tractor: (e.text.match(/T\d+/) || [''])[0], job: e.text, state: 'job finished' });
  }
});

// ---- Status page: every tractor's state, the job list, the message trail, and each AgOpenWeb view.
const recent = [];
const _trail = trail;
trail = function (from, to, type, text, data) { recent.push({ clock: fmtTime(sim.time), from, to, type, text, ...(data?.lines ? { lines: data.lines, footer: data.footer } : {}) }); if (recent.length > 60) recent.shift(); return _trail(from, to, type, text, data); };
function stateOf(u) {
  const t = u.twin, k = t.action?.kind;
  if (u.fault === 'NO_RESPONSE') return { code: 'NO_RESPONSE', text: 'Not responding' };
  if (u.fault === 'GO_NOT_MOVING') return { code: 'GO_NOT_MOVING', text: 'GO acknowledged, GPS not moving' };
  if (t.status !== 'ok') return { code: 'DOWN', text: 'Out of service' };
  if (k === 'work' && t.jobId && u.place === sim.jobs.get(t.jobId)?.fieldId && heldBy(sim.jobs.get(t.jobId))) return { code: 'HOLD', text: 'Stopped: job on hold' };
  if (k === 'work') return { code: 'WORKING', text: 'Working' };
  if (k === 'goto') return { code: 'DRIVING', text: 'Driving' };
  if (k === 'swap') return { code: 'SWAP', text: 'Changing implement' };
  if (k === 'refuel') return { code: 'REFUEL', text: 'Refuelling' };
  return { code: 'STANDBY', text: 'Standing by' };
}
function snapshot() {
  const assign = sim.dispatcher.plan?.assign || {};
  return {
    scenario: scenario.name, clock: fmtTime(sim.time), secPerMin: SEC, finished: stopped, mode,
    backlog: backlog.map(b => ({ id: b.id, field: b.field, type: b.type, label: labelOf(b), priority: b.priority, deadline: fmtTime(b.deadline), waitsFor: b.waitsFor ? labelOf(backlog.find(x => x.id === b.waitsFor) || { id: b.waitsFor, type: 'till', field: '' }) : null, status: b.status })),
    holds: [...holds.values()], recalls: [...recalls.values()],
    // Strips of ground already worked, from the legs each job has really completed. Views draw from this.
    coverage: [...routes.entries()].map(([id, r]) => {
      const segs = r.pts.slice(0, r.done ? r.pts.length : r.i).filter(q => q.paint).map(q => [q.from.e, q.from.n, q.e, q.n].map(v => +v.toFixed(1)));
      const q = r.pts[r.i];
      if (!r.done && q?.paint && r.cur) segs.push([q.from.e, q.from.n, r.cur.e, r.cur.n].map(v => +v.toFixed(1)));
      return { job: id, field: r.field, type: sim.jobs.get(id)?.type, widthM: r.width, segs };
    }),
    ground: Object.fromEntries(Object.keys(ground).map(k => [k, { now: GROUND_WORD[ground[k]], planned: GROUND_WORD[groundOnceListDone(k)] }])),
    roundtable: roundLines.slice(-30).reverse(), agents: rt.agents, roundtableStats: rt.stats(),
    tractors: units.map((u, i) => {
      const w = world(u.twin);
      return {
        id: u.id, name: u.twin.name, agopenPort: nodePorts[i] - 1000, state: stateOf(u), task: u.cmd?.label || '',
        mounted: u.twin.mounted, fuelPct: Math.round(100 * u.twin.fuel / u.twin.fuelCapacity),
        queue: (assign[u.id] || []).map(x => x?.id ?? x),
        tel: u.tel, heardAgoMs: u.lastSeen ? Date.now() - u.lastSeen : null, eta: u.eta?.out || null,
        planGapM: planGap(u, w),
      };
    }).concat(truckReady() ? [{
      id: truck.id, name: truck.name, kind: 'fuel-truck', agopenPort: Number(opt('truck', 6178)) - 1000,
      state: fuelMission ? (fuelMission.phase === 'fuelling' ? { code: 'REFUEL', text: 'Refuelling a tractor' } : fuelMission.phase === 'meet' ? { code: 'STANDBY', text: 'Waiting at the field' } : { code: 'DRIVING', text: 'Driving' }) : { code: 'STANDBY', text: 'Standing by' },
      task: truck.cmd?.label || '', mounted: 'fuel tank', fuelPct: 100, queue: [],
      tel: truck.tel ? { ...truck.tel, rig: null } : null, heardAgoMs: Date.now() - truck.lastSeen, planGapM: null,
    }] : []),
    weather: (() => { const c = weather.current(); return c ? { day: weather.day, clock: c.reading.clock, low: c.reading.low, high: c.reading.high, status: c.assessment.status, reason: c.assessment.reason, groundOnly: c.assessment.groundOnly, caughtByTwoHeights: c.assessment.caughtByTwoHeights, log: weather.log().filter(x => x.note).slice(-6).reverse() } : null; })(),
    fields: (() => { try { return fieldStatus(); } catch (err) { return []; } })(),
    ai: { on: aiDrive },
    plan: (() => { try { return planView(); } catch (err) { return { tasks: [], schedule: [], nowMin: sim.time, dayEndMin: 660, error: err.message }; } })(),
    drone: { ...drone.state(), reports: droneReports.slice(-3).reverse(), sprayed: droneSprayed, wind: droneWind },
    fuelPlan: fuelMission ? { tractor: fuelMission.u.id, phase: fuelMission.phase, ...fuelMission.numbers } : null, fuelScale: FUEL_SCALE,
    jobs: [...sim.jobs.values()].map(j => ({
      id: j.id, label: sim.label(j), field: sim.fields.get(j.fieldId)?.name, type: j.type, status: j.status, priority: j.priority, deadline: fmtTime(j.deadline),
      pct: j.status === 'done' ? 100 : Math.round(100 * (routes.get(j.id)?.fraction ?? (1 - j.remaining / j.acres))),
      route: routes.get(j.id) ? { passes: routes.get(j.id).plan.swaths.length, widthM: routes.get(j.id).width, lengthM: Math.round(routes.get(j.id).plan.lengthM), fieldM2: Math.round(routes.get(j.id).fieldM2) } : null,
      tractor: Object.keys(assign).find(id => (assign[id] || []).some(x => (x?.id ?? x) === j.id)) || (sim.tractors.find(t => t.jobId === j.id)?.id ?? ''),
    })),
    tasks: tasks.filter(x => x.state !== 'done').map(x => ({ id: x.id, tractor: x.tractor, kind: x.kind, text: x.text, state: x.state, since: x.clock })),
    trail: recent.slice(-40).reverse(),
  };
}
const PAGE_PORT = Number(opt('page', 5190));
const server = http.createServer((req, res) => {
  if (req.url === '/chat/history') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ messages: chat.history() })); }
  if (req.method === 'POST' && req.url === '/chat/reset') { chat.reset(); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
  if (req.method === 'POST' && req.url === '/chat') {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const text = JSON.parse(body || '{}').text;
        trail('operator', 'assistant', 'chat', String(text || '').slice(0, 300));
        const msg = await chat.send(text);
        trail('assistant', 'operator', 'chat', msg.text.slice(0, 400), msg.actions.length ? { actions: msg.actions.map(a => a.summary) } : {});
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(msg));
      } catch (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ role: 'assistant', text: String(err.message), clock: fmtTime(sim.time), actions: [], drone: null })); }
    });
    return;
  }
  // "Why?" for any job: the planner's own reasons for who has it and when it will finish.
  const why = req.method === 'GET' && req.url.match(/^\/why\/([\w-]+)$/);
  if (why) {
    let lines;
    try { lines = [].concat(sim.dispatcher.why(sim, why[1])); } catch (err) { lines = [`No explanation available: ${err.message}`]; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ job: why[1], label: sim.jobs.get(why[1]) ? sim.label(sim.jobs.get(why[1])) : why[1], lines }));
  }
  if (req.url === '/state') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(snapshot())); }
  const m = req.method === 'POST' && req.url.match(/^\/human\/(H\d+)\/go$/);
  if (m) {
    const k = tasks.find(x => x.id === m[1]);
    if (!k || k.state !== 'waiting') { res.writeHead(409); return res.end(k ? 'The tractor is not parked at the depot yet.' : 'unknown task'); }
    k.go = true; res.writeHead(200); return res.end('ok');
  }
  // The 3D view replays this log against its own copy of the planner's world, so both show the same day.
  if (req.url === '/replay') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ time: sim.time, finished: sim.finished || stopped, entries: replay })); }
  if (req.url === '/scenario.json') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ ...scenario, events: [] })); }
  if (req.method === 'POST' && req.url === '/event') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { try { const e = JSON.parse(body); delete e.time; sim.inject(e); res.writeHead(200); res.end('ok'); } catch { res.writeHead(400); res.end(); } });
    return;
  }
  if (req.method === 'GET' && (req.url.startsWith('/dashboard/') || req.url.startsWith('/src/'))) {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html');
    const file = path.join(repo, rel);
    if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(file));
  }
  if (req.url === '/farm') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ home: HOME, depot: scenario.depot.name, source: FIELDS_DIR, fields: readAgFields(), lanes: laneNet.lanes, gates: Object.values(laneNet.gates).map(g => ({ e: g.e, n: g.n })), bays: units.map(u => ({ id: u.id, ...u.bay })) }));
  }
  const readBody = (cb) => { let body = ''; req.on('data', c => { body += c; }); req.on('end', () => { let b; try { b = JSON.parse(body || '{}'); } catch { res.writeHead(400); return res.end('The request was not valid JSON.'); } try { cb(b); } catch (err) { res.writeHead(409); res.end(String(err.message)); } }); };
  const ok = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj ?? { ok: true })); };
  // Job list
  if (req.method === 'POST' && req.url === '/draft') return readBody((b) => { const added = draftJobs(b); enforcePriorities(); ok({ added }); });
  if (req.method === 'POST' && req.url === '/job/priority') return readBody((b) => ok(setPriority(String(b.job), String(b.priority))));
  if (req.method === 'POST' && req.url === '/jobs') return readBody((b) => ok({ added: draftJobs({ fields: b.fields, steps: [b.type], priority: b.priority, deadline: b.deadline }) }));
  if (req.method === 'DELETE' && req.url.startsWith('/draft/')) { try { removeDraft(decodeURIComponent(req.url.slice(7))); return ok(); } catch (err) { res.writeHead(409); return res.end(String(err.message)); } }
  if (req.method === 'POST' && req.url === '/field/crop') return readBody((b) => {
    const rec = fieldRecord[b.field], crop = String(b.crop || '').toLowerCase();
    if (!rec) throw new Error(`Unknown field: ${b.field}`);
    if (!SEASON_DAYS[crop]) throw new Error(`Unknown crop: ${b.crop}`);
    rec.nextCrop = crop; rec.cropPicked = true; saveRecord(b.field);
    trail('operator', 'crop-manager', 'crop-choice', `${b.field}: ${crop} picked as the next crop to sow.`);
    ok({ field: b.field, crop });
  });
  if (req.method === 'POST' && req.url === '/ai') return readBody((b) => { setAiDrive(!!b.on); ok({ on: aiDrive }); });
  if (req.method === 'POST' && req.url === '/reset') { ok(); return startOver(); }
  if (req.method === 'POST' && req.url === '/drone/scan') return readBody((b) => { const done = (b.fields || []).filter(droneScan); if (!done.length) throw new Error('Pick at least one field on the map first.'); ok({ scanning: done }); });
  if (req.url === '/weather-log') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(weather.logText()); }
  if (req.method === 'POST' && req.url === '/start') { try { startDay(); return ok(); } catch (err) { res.writeHead(409); return res.end(String(err.message)); } }
  // For agents: place or lift a hold on a kind of work, and speak on the message trail.
  if (req.method === 'POST' && req.url === '/hold') return readBody((b) => {
    if (!b.id || !Array.isArray(b.jobTypes) || !b.jobTypes.length) throw new Error('A hold needs an id and jobTypes.');
    const fresh = !holds.has(b.id);
    holds.set(b.id, { id: String(b.id), jobTypes: b.jobTypes, fields: Array.isArray(b.fields) && b.fields.length ? b.fields : null, reason: String(b.reason || 'no reason given'), by: String(b.by || 'agent'), since: fmtTime(sim.time) });
    if (fresh) { trail(String(b.by || 'agent'), 'executor', 'hold', `Hold on ${b.jobTypes.join(', ')} work${b.fields?.length ? ` in ${b.fields.join(', ')}` : ''}: ${b.reason || 'no reason given'}`); discuss('hold', `Hold on ${b.jobTypes.join(', ')} work`, { reason: b.reason, by: b.by, work: b.jobTypes.join(', '), fields: b.fields || 'all fields' }); }
    ok({ hold: b.id });
  });
  if (req.method === 'DELETE' && req.url.startsWith('/hold/')) {
    const h = holds.get(decodeURIComponent(req.url.slice(6)));
    if (h) { holds.delete(h.id); trail(h.by, 'executor', 'hold-lifted', `Hold on ${h.jobTypes.join(', ')} work lifted.`); discuss('hold-lifted', `Hold on ${h.jobTypes.join(', ')} work lifted`, { reason: h.reason, by: h.by, work: h.jobTypes.join(', ') }); }
    return ok();
  }
  if (req.method === 'POST' && req.url === '/recall') return readBody((b) => {
    if (!b.id) throw new Error('A recall needs an id.');
    const fresh = !recalls.has(b.id);
    recalls.set(b.id, { id: String(b.id), reason: String(b.reason || 'no reason given'), by: String(b.by || 'agent'), since: fmtTime(sim.time) });
    if (fresh) { trail(String(b.by || 'agent'), 'executor', 'recall', `Fleet recalled to the depot: ${b.reason || 'no reason given'}`); discuss('hold', `Fleet recalled: ${b.reason}`, { reason: b.reason, by: b.by, work: 'all work', state: 'recall' }); }
    ok({ recall: b.id });
  });
  if (req.method === 'DELETE' && req.url.startsWith('/recall/')) {
    const r0 = recalls.get(decodeURIComponent(req.url.slice(8)));
    if (r0) { recalls.delete(r0.id); trail(r0.by, 'executor', 'recall-ended', 'Recall ended. Tractors may leave the depot.'); discuss('hold-lifted', 'Recall ended', { reason: r0.reason, by: r0.by, work: 'all work' }); }
    return ok();
  }
  if (req.method === 'POST' && req.url === '/agent/say') return readBody((b) => { const text = String(b.text || '').slice(0, 400); trail(String(b.from || 'agent'), String(b.to || 'operator'), String(b.type || 'note'), text); roundLines.push({ id: `x${roundLines.length}`, topicId: 'outside', topic: 'From another agent', agent: String(b.from || 'agent'), role: '', text, kind: 'says', clock: fmtTime(sim.time) }); ok(); });
  if (req.method === 'POST' && req.url.startsWith('/cmd/')) { command(decodeURIComponent(req.url.slice(5))); res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  const want = req.url.split('?')[0];
  const page = want === '/3d' && fs.existsSync(path.join(here, 'live3d.html')) ? 'live3d.html' : want === '/chat' && fs.existsSync(path.join(here, 'chat.html')) ? 'chat.html' : 'live.html';
  res.end(fs.readFileSync(path.join(here, page)));
});
// When this process restarts itself (Start over), the old one may still hold the port for a moment.
let listenTries = 0;
server.on('error', (err) => { if (err.code === 'EADDRINUSE' && listenTries++ < 20) setTimeout(() => server.listen(PAGE_PORT), 300); else throw err; });
server.listen(PAGE_PORT, () => console.log(`Status page → http://localhost:${PAGE_PORT}/`));

// Start over: every tractor goes back to its bay, and this runner restarts itself with an empty job list
// and the clock at the start of the day.
function startOver() {
  if (stopped) return;
  stopped = true;
  console.log('\nStarting over: tractors back to their bays, job list cleared.');
  // Clear any injected fault first: a tractor left "not responding" would give no telemetry to the fresh start.
  Promise.allSettled([...units, truck].map(u => call(u, 'POST', '/fault/ok', {}).catch(() => {}).then(() => call(u, 'POST', '/release', {})).catch(() => {}).then(() => call(u, 'POST', '/home', {})))).then(() => {
    server.close();
    spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit' });
    setTimeout(() => process.exit(0), 250);
  });
}

await poll();
const missing = units.filter(u => !u.tel).map(u => `${u.id} (${u.url})`);
if (missing.length) { console.log(`No telemetry from ${missing.join(', ')}. Start each with: node agopen/tractor-node.js <id> <agopen port>`); process.exit(1); }

setInterval(() => { if (!stopped) { poll(); pollTruck(); } }, 250);
setTimeout(() => { if (!stopped && aiDrive) { try { aiPlan(); } catch (err) { console.log('AI drive: ' + err.message); } } }, 4000);
setInterval(() => { if (!stopped) { dispatch(); truckTick(); droneTick(0.25); } }, 250);
setInterval(() => { if (!stopped) status(); }, 8000);
setInterval(() => {
  if (stopped) return;
  for (const s of script) if (!s.done && sim.time >= s.at) { s.done = true; command(s.cmd); }
  if (sim.time >= UNTIL) return finish(`reached ${fmtTime(UNTIL)}`);
  if (mode !== 'running') return;                                   // tractors wait at home until the day is started
  releaseReady();
  const work = sim.openJobs().length > 0 || sim.pending.length > 0;
  if (!work) return;                                                // nothing to do: the clock waits with the fleet
  if (sim.finished) sim.finished = false;
  updateEtas();
  weatherTick();
  try { cropManager(); aiPlan(); } catch (err) { console.log('crop manager: ' + err.message); }
  fuelPlanning();
  humanGate();
  syncProgress();
  sim.step();
}, SEC * 1000);
