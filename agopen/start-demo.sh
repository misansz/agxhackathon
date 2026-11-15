#!/bin/bash
# The whole live demo, from a clean state, in one command (macOS):
#   - three AgOpenWeb copies (one per tractor), with the farm and implement profiles freshly written
#   - one Terminal window per tractor, printing telemetry every second (type dead / stuck / ok into it)
#   - one Terminal window running the coordinator
#   - the status page in your browser, then a preflight check
# Usage: agopen/start-demo.sh        agopen/start-demo.sh stop
# LIVE_ARGS passes options to the coordinator. Unset, fuel use is scaled up (--fuel-scale 70) so that refuelling,
# and the fuel truck's trip to a tractor in a far field, come up within a short demo.
REPO="$(cd "$(dirname "$0")/.." && pwd)"
MULTI="${AGOPEN_MULTI:-$REPO/../agopen-multi}"
stop_all() {
  pkill -f "agopen/tractor-node.js" 2>/dev/null; pkill -f "agopen/live.js" 2>/dev/null; pkill -f "agents/server.js" 2>/dev/null
  "$MULTI/start-fleet.sh" stop >/dev/null 2>&1
  rm -f "$REPO"/agopen/out/lock-*.json
}
if [ "$1" = "stop" ]; then stop_all; echo "Everything stopped."; exit 0; fi
if [ ! -x "$MULTI/bin/AgOpenWeb.Desktop" ]; then echo "No patched AgOpenWeb build in $MULTI/bin. See the README, Get it running, section 2."; exit 1; fi
# First run: put the script that starts the AgOpenWeb copies next to the build.
if [ ! -x "$MULTI/start-fleet.sh" ]; then cp "$REPO/agopen/agopenweb/start-fleet.sh" "$MULTI/start-fleet.sh" && chmod +x "$MULTI/start-fleet.sh"; fi

echo "1/5 Stopping anything left from an earlier run..."
stop_all
# Fields remember their status between runs (crop-record.json in each field's AgOpenWeb folder, and the last drone
# surveys). FRESH=1 puts the farm back to its starting mix and forgets the surveys and the AI-drive switch.
if [ -n "${FRESH:-}" ]; then rm -f "$MULTI"/data-5175/AgOpenWeb/Fields/*/crop-record.json "$REPO"/agopen/out/field-memory.json "$REPO"/agopen/out/ai-drive.json; fi
echo "2/5 Writing the farm and implement profiles into each AgOpenWeb copy..."
(cd "$REPO" && node agopen/build-farm.js) || exit 1
echo "3/5 Starting four AgOpenWeb copies (three tractors and the fuel truck)..."
"$MULTI/start-fleet.sh" 4 >/dev/null 2>&1 </dev/null
for P in 5175 5176 5177 5178; do
  for k in $(seq 1 40); do curl -s -o /dev/null -m 1 "http://localhost:$P/" && break; sleep 0.5; done
  curl -s -o /dev/null -m 1 "http://localhost:$P/" || { echo "AgOpenWeb did not start on port $P. See $MULTI/tractor-$P.log"; exit 1; }
done
sleep 2

win() { # title, x, y, width, height, command
  osascript >/dev/null <<OSA
tell application "Terminal"
  activate
  set w to do script "clear; printf '\\\\e]0;$1\\\\a'; cd '$REPO' && $6"
  delay 0.3
  set bounds of front window to {$2, $3, $(($2 + $4)), $(($3 + $5))}
end tell
OSA
}
echo "4/5 Opening a Terminal window per tractor, then the coordinator..."
win "Tractor T1 telemetry" 0    560 640 300 "node agopen/tractor-node.js T1 5175 --depot"
win "Tractor T2 telemetry" 640  560 640 300 "node agopen/tractor-node.js T2 5176 --depot"
win "Tractor T3 telemetry" 1280 560 640 300 "node agopen/tractor-node.js T3 5177 --depot"
win "Fuel truck telemetry" 960 40 640 300 "node agopen/tractor-node.js FUEL 5178 --depot --bay 3"
for P in 6175 6176 6177 6178; do for k in $(seq 1 40); do curl -s -m 1 -o /dev/null "http://127.0.0.1:$P/telemetry" && break; sleep 0.5; done; done
win "Fleet coordinator" 0 40 960 500 "node agopen/live.js ${LIVE_ARGS---fuel-scale 70}"
for k in $(seq 1 30); do curl -s -m 1 -o /dev/null http://127.0.0.1:5190/state && break; sleep 0.5; done
# Optional: the durable agent team in agents/ on port 5200, speaking at the same roundtable. Its own weather
# agent is left out because the coordinator already reads the weather; two sources would contradict each other.
# Each run gets a fresh memory folder, so it does not open with yesterday's faults.
# Usage: WITH_AGENTS=1 agopen/start-demo.sh
if [ -n "${WITH_AGENTS:-}" ]; then
  pkill -f "agents/server.js" 2>/dev/null
  win "Agent team" 960 360 640 200 "AGENTS=plan,fleet,fault,route,depot,safety,records AGENTS_DATA=agents/data/run-$(date +%H%M%S) node agents/server.js"
fi
open "http://localhost:5190/"
echo "5/5 Preflight:"
(cd "$REPO" && node agopen/preflight.js)
