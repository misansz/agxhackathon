# Run the Fleet — AI Farm Orchestrator

A coordinator that assigns field jobs to a small fleet of autonomous tractors, re-plans in milliseconds when something goes wrong, and explains every change in plain language. It also answers "why?" for any assignment.

**Simulation: both.**
- **Our own simulation** (default; all results below): a minute-by-minute farm sim on a 30×20 grid, with a creek crossed by two bridges, a depot (fuel and implement shed), 9 fields and 3 tractors. Judges score the coordinator, so we kept the sim small and spent our time on the planning.
- **AgOpenWeb** (stretch goal, [`agopen/`](agopen/README.md)): the same coordinator drives three real AgOpenWeb instances, one per tractor. It reads fields and implements from AgOpenWeb, detects faults from live telemetry, and reassigns work when a tractor goes silent or stops moving. It needs the .NET 10 SDK and a small multi-instance patch, so it is not required to run anything else here.

**Stack:** Node.js 18+. The planner, simulator and CLI have no dependencies; the dashboard server uses the Anthropic SDK for optional Claude explanations, and the 3D view loads three.js from a CDN. The same coordinator code runs in the CLI, live in the browser, and against AgOpenWeb.

## Get it running

There are three ways to run this, from least to most set-up. All of them need [Node.js](https://nodejs.org) 18 or later.

| | What you get | Needs | Time |
|---|---|---|---|
| **1. Live dashboard, any computer** | The operator dashboard, planner, assistant, drone and fuel truck, with stand-in vehicles | Node.js | 2 minutes |
| **2. Full demo on AgOpenGPS** | The same, with every vehicle driven in its own AgOpenWeb (AgOpenGPS) simulator | macOS, Node.js, .NET 10 SDK | about 15 minutes, once |
| **3. Planner on its own** | The planner against the first-come-first-served baseline, in the terminal, plus the 3D Command Center | Node.js | 1 minute |

### 1. Live dashboard on any computer

```bash
git clone https://github.com/misansz/agxhackathon.git
cd agxhackathon
npm install
npm run demo
```

The last command writes the farm, starts four stand-in vehicles (tractors T1, T2, T3 and the fuel truck) and the coordinator, and opens the dashboard at http://localhost:5190. Stop everything with Ctrl+C.

Things to try, in order:

1. Each field on the map says what is on it ("Corn — estimated harvest in 36 days", "Empty — needs tilling").
2. Press **Plan jobs**, click a field's action ("Plow and sow", "Sow ..."), close, press **Start the day**. Or switch on **Let the AI drive**.
3. When **Needs a person** lights up, a tractor is locked at the depot for fuel or an implement change. Press **Good to go**.
4. Break a tractor: open its **Detail** line under Fleet and press **Inject: GO but not moving**. Watch **Latest plan change** explain who took the work and why. Press **Why?** on any job.
5. Press **Ask the assistant** and type "What is North Field like?".

Options: `npm run demo -- --speed 3` (vehicles three times faster), `--fresh` (new random mix of fields), `--page 5200` (another port), `--no-open`. Anything else goes to the coordinator, for example `--weather calm`.

The assistant and the roundtable of AI managers use Claude when an API key is set, and plain rule-written text when it is not. Set it before starting:

```bash
export ANTHROPIC_API_KEY=sk-ant-...        # macOS, Linux
$env:ANTHROPIC_API_KEY = "sk-ant-..."      # Windows PowerShell
```

The 3D view and the drone camera load three.js from the internet.

Tested: from a fresh clone on macOS with Node 20 (the farm came up, a job ran to 28%, the assistant answered). Not tested on Windows or Linux; the launcher is plain Node. On Windows there is also `agopen\start-demo-windows.cmd`, which opens one window per vehicle so you can type `stuck`, `dead` or `ok` into it.

In this mode the vehicles are stand-ins (`agopen/mock-node.js`): they take the same commands and send the same telemetry as the real ones, but move by their own simple model, and the small vehicle windows on the dashboard show a placeholder.

### 2. Full demo on AgOpenGPS (macOS)

Each vehicle is a real AgOpenWeb copy (the web build of AgOpenGPS) running its own simulator; the coordinator reads the fields and implements from it and drives it. AgOpenWeb normally allows one copy per computer, so a small patch (four changes, described in [`agopen/README.md`](agopen/README.md#set-up-once)) lets four run side by side.

You need macOS, Node.js 18+, git and the [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0) (`dotnet --version` should print 10.x).

Put AgOpenWeb next to this repository, so the folders sit side by side:

```
some-folder/
  agxhackathon/     this repository
  AgOpenWeb/        AgOpenWeb's source, patched
  agopen-multi/     created by the build: the patched program and one data folder per vehicle
```

From `some-folder`:

```bash
git clone https://github.com/AgOpenGPS-Official/AgOpenWeb.git
cd AgOpenWeb
git checkout 682b68d9669fa207cdceab720760302afe3a871d
git apply ../agxhackathon/agopen/agopenweb/agopenweb-multi-instance.patch
DesktopOnly=true dotnet build Platforms/AgOpenWeb.Desktop -o ../agopen-multi/bin
cd ../agxhackathon
npm install
agopen/start-demo.sh
```

`start-demo.sh` writes the farm into each AgOpenWeb copy, starts the four copies, opens a Terminal window per vehicle (telemetry every second) and one for the coordinator, opens the dashboard, and runs a preflight check. Wait for `All checks passed. Ready to demo.`

- The first time, macOS asks whether the launcher may control Terminal. Allow it: that is how the windows are opened.
- Stop everything: `agopen/start-demo.sh stop`
- Start with a new random mix of fields: `FRESH=1 agopen/start-demo.sh`
- Check a running demo again: `node agopen/preflight.js`
- Inject a fault: type `stuck` or `dead` in a tractor's Terminal window (`ok` to recover), or use the buttons in its Detail line on the dashboard.
- The five-minute run of show is at the top of [`agopen/DEMO.md`](agopen/DEMO.md); everything else about the live mode is in [`agopen/README.md`](agopen/README.md).

Checked on 15 November 2026 (macOS, .NET 10.0.404): the patch applies to a clean checkout of that commit and the build finishes with 0 errors. The first build downloads packages and takes a few minutes. The launch itself was run many times from an earlier build of the same patched source, not from that fresh build.

### 3. Planner on its own

No browser and no vehicles: the planner and the first-come-first-served baseline run the same scripted day and write the logs and the comparison to `out/`.

```bash
node cli.js                 # coordinator against the baseline, with scripted breakdowns and closures
node cli.js --why J13       # why a job is where it is
node serve.js               # the 3D Command Center at http://localhost:5180
npm test                    # the live mode's tests
```

More commands are under [Run it](#run-it) below.

### If something goes wrong

| What you see | What to do |
|---|---|
| "Packages are not installed yet" | Run `npm install` in the repository folder. |
| "... did not start. Is another copy already running on that port?" | Stop the other copy (Ctrl+C in its terminal, or `agopen/start-demo.sh stop`), or use `npm run demo -- --page 5200 --base 5275`. |
| "No patched AgOpenWeb build in ../agopen-multi/bin" | The build step in section 2 has not been run, or AgOpenWeb is not next to this repository. |
| "AgOpenWeb did not start on port 5175" | Look at `../agopen-multi/tractor-5175.log`. Usually .NET 10 is missing: check `dotnet --version`. |
| The assistant says it could not reach its language model | Set `ANTHROPIC_API_KEY` and check the internet connection. Everything else keeps working. |
| The 3D view or drone camera is blank | They need the internet for three.js. |
| A vehicle stops making progress, or anything looks stuck | Press **Start over** on the dashboard (fields keep their state). For a clean slate relaunch with `FRESH=1 agopen/start-demo.sh` or `npm run demo -- --fresh`. |
| "No telemetry from T2 ..." when the coordinator starts | That vehicle's process is not running. Relaunch with the launcher instead of starting the coordinator by hand. |

## Challenge checklist

| Must-have | Where it is |
|---|---|
| 1. Take a job list | Operator panel: submit one job or paste a JSON job list; `scenario.json` for the CLI |
| 2. Assign compatible tractors | `src/fleet.js`: implement, fuel reserve, reachability, shift and deadlines are hard constraints |
| 3. Show progress | 3D Command Center (`node serve.js`), 2D view at `/dashboard/classic.html` |
| 4. Recover from a breakdown | Re-plan in ms, partial acres kept, Safety Agent checks for duplicates and lost jobs: 0 in 200 random scenarios |
| 5. Explain the new plan | A notification for every re-plan, a full change list, and **Why?** on any job |

All five stretch goals are covered too: blocked routes and priority changes, fuel planning, beating the baseline, **Why?**, and AgOpenWeb.
**Run it.** After the one-time set-up in `agopen/README.md` (a patched AgOpenWeb build, `npm install`), one command starts everything on macOS:

```bash
agopen/start-demo.sh          # starts all vehicles, the coordinator and the status page, then a preflight check
agopen/start-demo.sh stop     # stops everything
LIVE_ARGS="--preset" agopen/start-demo.sh    # options for live.js, here: start with the scenario's 11 jobs
```

| What | Where |
| --- | --- |
| Status page (job list, tractor cards, roundtable, spray conditions, drone) | http://localhost:5190 |
| 3D view (needs the internet) | http://localhost:5190/3d |
| AgOpenWeb of T1, T2, T3 and FUEL | ports 5175, 5176, 5177, 5178 |
| Telemetry node of T1, T2, T3 and FUEL | ports 6175, 6176, 6177, 6178 |

`live.js` options (`LIVE_ARGS`), with defaults: `--cell` 20, `--sec` 1.8, `--until` none, `--preset` off, `--auto-humans` 0 (off), `--fuel-scale` 25 (the launcher passes 70), `--weather` demo (also `calm`, `windy`, `still`), `--truck` 6178, `--script` none, `--page` 5190.

**What it does**

- **Fault recovery.** Type `stuck` or `dead` in a tractor's Terminal window (`ok` to recover). The coordinator detects it from telemetry only, hands the unfinished job to another tractor and explains the change.
- **Field status and "Let the AI drive".** Each field's record (growing crop and planting date, stubble, or plowed soil) lives in its AgOpenWeb folder and is remembered between runs. The Add jobs panel shows how far along each crop is, when it should be ready and how sure that is given the last drone survey. A crop manager sends the drone to fields that have not been surveyed, and with **Let the AI drive** on it queues the plowing and sowing each field needs and starts the day. `FRESH=1 agopen/start-demo.sh` resets the fields to the starting mix.
- **Explanations on the page.** After every re-plan the dashboard shows one line per job that moved and why ("Latest plan change"), and every job row has a **Why?** button that gives the planner's reasons and the alternatives it rejected (`GET /why/<job id>`).
- **Full-length passes.** Every pass runs edge to edge and the tractor turns outside the field boundary, so coverage reaches the edges. There is no headland lap.
- **People in the loop.** A refuel or an implement change locks the tractor until a person presses **Good to go** on the status page. An implement change is then written to that tractor's AgOpenWeb (`profile.load`). Nothing is sown before it is plowed.
- **Fuel truck.** The planner compares the cost in US dollars of a detour via the depot with the fuel truck's round trip (rates in `agopen/scenario.live.json` under `costs`), picks the cheaper and sends the truck so that it arrives as the job ends. Each tractor card shows when its job finishes, when its fuel reaches the reserve, and the next refuel choice with both costs.
- **Spray or Wait?** Weather at 2 m and 10 m, an inversion check, wind limits (2 m wind 3 to 10 mph, at most 5 mph between heights), and Go, Caution or Stop with a reason. Every change is time-stamped in the log at `GET /weather-log`. A Stop holds spray jobs and releases them when conditions return.
- **Scout drone (simulated).** Scans a field for crop status (`POST /drone/scan`, or **Map the picked fields** on the status page), is sent to look at a faulted tractor, circles it with the camera kept on it, flies above a spraying tractor reading the wind at 10, 30 and 50 m, shows the 3D farm from its own camera, and can spot-spray.
- **Roundtable of AI managers** (`agopen/roundtable/`, one manager per task for the whole fleet, model `claude-haiku-5-5`, rule-written lines when offline) explain each event. They never move a tractor.
- **AgOpenWeb patch** (`agopen/agopenweb/agopenweb-multi-instance.patch`), four changes: `AGOPENWEB_PORT`, a single-instance lock named per port, `AGOPENWEB_OPERATOR=Fleet` (only clients named Fleet... can take the controls) and `?embed=1` (a map-only page for the small windows on the status page).

**Hand-in files for the live mode**

| Item | Where |
| --- | --- |
| Scenario | [`agopen/scenario.live.json`](agopen/scenario.live.json) |
| Event log of the live run | [`agopen/handin/event-log.jsonl`](agopen/handin/event-log.jsonl), a copy of `agopen/out/trail.jsonl` (that file is emptied each time the coordinator starts) |
| Comparison against first come, first served | [`agopen/test/TEST_REPORT.md`](agopen/test/TEST_REPORT.md) |

Headline numbers from `agopen/test/TEST_REPORT.md` (breakdown day: T1 breaks at 07:00 and is repaired at 09:00):

| | Coordinator | First come, first served |
|---|---:|---:|
| Jobs completed (of 11) | 11 | 11 |
| Jobs finished on time | 11 | 7 |
| Travel (tractor-minutes) | 698 | 758 |
| Idle (tractor-minutes) | 0 | 22 |
| Day ended at | 15:56 | 17:16 |

**Known limits**

- After a hand-over, the new tractor drives the interrupted pass again from its start.
- Lanes do not react to a `block_route` event.
- The 3D view and the roundtable model lines need the internet. Without it, the roundtable uses rule-written lines.

## Run it

```bash
npm install                 # only needed for the dashboard server (Anthropic SDK)
node cli.js                 # demo day with scripted events: coordinator vs FCFS baseline → out/
node cli.js --no-events     # same farm, no disruptions
node cli.js --why J13       # print the "why?" explanation for any job
node stress.js 200          # 200 random scenarios: invariants + comparison
node serve.js               # 3D Command Center → http://localhost:5180/
node gis/fetch.js           # optional: refresh the real aerial photo, canals, roads, soil and elevation
```

To have Claude write the notifications and answer "why?" questions, start the server with an API key:

```bash
ANTHROPIC_API_KEY=sk-ant-... node serve.js
```

Without a key everything still works: notifications and answers come from the planner's own rule-based explanations, and the dashboard shows which one you're getting.

### 3D Command Center

- **3D farm** (three.js): fields with crop rows that fill in as work progresses, the creek and bridges, the depot, and a low-poly tractor for each machine with its current implement. The beacon is green while working, amber while driving and flashing red when broken down. Drag to orbit, scroll to zoom, and click a tractor or field for a pop-down card.
- **Real-world layer** (the **Satellite** button): the farm is drawn on a real aerial photo of open farmland in the Yuma Valley, Arizona (depot at 32.660, −114.740, 100 m per grid cell), with the real canals and roads from OpenStreetMap. Click a field to see its real soil survey unit, drainage, slope and elevation. `node gis/fetch.js` pulls all of it into `dashboard/gis/`; every source is public and credited on screen (USDA NAIP aerial photography, OpenStreetMap, USDA NRCS soil survey, USGS or Copernicus elevation).
  - What is real: the photo, canals, roads, soil and elevation. What is simulated: the field rectangles, Mill Creek and its two bridges, which come from `scenario.json`. The planner does not use the GIS layer; it changes no result below.
- **Look:** translucent "liquid glass" panels, no icons, and only the labels an operator needs. The drawn farm is the default view.
- **Agents:** the **Agents** button opens a flow chart of which agent speaks to which, drawn from the agent code: Weather, Fault and Safety report to the Plan Manager, who decides and tells the operator; Weather and Fleet send requests to the Depot Manager, who gives people their tasks; Route, Agronomy and Records speak straight to the operator.
- **Re-routing in 3D:** each tractor's live route is a glowing path. When the planner re-routes it, the abandoned route fades out in red and the new one draws in. Planned future legs show as dashed lines. A closed bridge gets a red barrier and a flashing lamp, and every event sends a pulse ring out from where it happened.
- **Data sources:** every disruption comes from a named feed: tractor telematics (fault codes, fuel), the weather service, bridge water-level gauges, drone and satellite imagery, dealer service tickets, soil-moisture probes, or the operator. The Data sources panel shows each feed's latest reading and flags alerts. Notifications, the event log and Claude's explanations all cite the source.
- **A notification for every shift:** each re-plan drops down a notification with a short title and reason, written by Claude (Opus 5.5) from the planner's facts. Claude explains the decision; the algorithmic planner makes it. Each notification has Details (the planner's full change list) and **Why?**.
- **Ask why:** the copilot answers free-form questions about any plan change, job or tractor, grounded in the planner's reasoning, its rejected alternatives and the current feed readings.
- **Pop-down panels:** Fleet, Jobs, Data sources and Operator, plus a "Needs your decision" card for late or unfittable jobs, with Approve late / Drop / Why?.
- The original 2D dashboard is still at `/dashboard/classic.html`.

Operator controls:
- break or repair a tractor
- close or reopen a bridge
- change a job's priority or deadline
- submit a single job, or paste a JSON job list
- approve a late finish, or drop a job
- click any job to ask **why?**
- "Compare" replays the same day, including your manual actions, with both dispatchers.
- Switch to **FCFS baseline** mode to watch the starter dispatcher run the same farm.

## Hand-in files

| Item | Where |
|---|---|
| Scenario (tractors, fields, jobs, events) | [`scenario.json`](scenario.json) |
| Event log of the demo run (coordinator) | [`out/event_log.txt`](out/event_log.txt) (human), [`out/event_log.jsonl`](out/event_log.jsonl) (machine) |
| Baseline event log, same run | [`out/event_log_baseline.txt`](out/event_log_baseline.txt) |
| Comparison against the baseline | [`out/comparison.md`](out/comparison.md), [`out/no-events/comparison.md`](out/no-events/comparison.md), [`out/stress_200.txt`](out/stress_200.txt) |

## Results

**Demo day with events.** Scripted events:
- 07:40: T1 (the main sprayer) breaks down for 2 h 50 min
- 08:30: an urgent new spray job arrives
- 09:20: the south bridge washes out
- 10:00: a hay field becomes high priority because rain is forecast
- 10:30: T1 is repaired

| Metric | Coordinator | FCFS baseline |
|---|---:|---:|
| Jobs completed (of 13) | **13** | 10 |
| …on time | **11** | 7 |
| Priority-weighted acres on time | **660** | 358 |
| Travel (tractor-min) | **746** (−26%) | 1004 |
| Idle in the working day (tractor-min) | 0 | 0 |
| Implement swaps | **3** | 5 |
| Unannounced constraint violations | **0** | 3 |
| Late jobs, each forecast and flagged to the operator when the event made it unavoidable | 2 | — |
| All work finished | **17:26** | not finished by 18:00 |

**Same farm, no events.**

| Metric | Coordinator | FCFS baseline |
|---|---:|---:|
| On time | **12 / 12** | 8 / 12 |
| Travel (tractor-min) | **540** (−39%) | 892 |
| Refuel stops / implement swaps | **4 / 2** | 6 / 4 |
| All work finished | **15:47** | not finished by 18:00 |

**200 random scenarios.** Each has random jobs, fuel levels and 0–4 events (breakdowns, repairs, closures, priority changes, new jobs).
- The coordinator does more priority-weighted on-time work in 168 of 200 scenarios, ties in 22 and is worse in 10.
- It completes 1387 jobs on time against 1108 for the baseline.
- It drives 18% less and sits idle 61% less (1603 vs 4124 tractor-min).
- It has **0** unannounced violations, against 346 for the baseline.
- No acre was lost or worked twice, and nothing crashed.
- The slowest re-plan took 9 ms.

### Metric definitions
- **Travel**: minutes spent driving, including trips to the depot.
- **Idle**: minutes a working tractor sat free, or waited for a field another tractor was on, while compatible work was still open. Counted up to that tractor's last task of the day.
- **Spare capacity**: minutes after a tractor's last task. The tractor finished early and is free for new work, so this is reported separately rather than as idle.
- **Broken-down time** is excluded from both.
- **Unannounced violations**: any deadline missed without prior warning, a fuel-reserve breach, a duplicate assignment or an unsafe plan.

## Architecture

This maps to the "AI Farm Orchestrator" layer of ATC's diagram.

```
 Operator ──jobs/events──► Coordinator (src/coordinator.js)
                              ├─ Fleet Agent       src/fleet.js       assign + order jobs
                              ├─ Navigation Agent  src/navigation.js  routes, closures, detours
                              ├─ Safety Agent      src/safety.js      checks every plan before release
                              ├─ Explainer         src/explain.js     plan diffs + "why?"
                              └─ Data sources      src/sources.js     telematics, weather, gauges, imagery, service, soil
 Claude explanations (optional)  src/llm.js via serve.js /api/explain, /api/why
                                          │ next job per tractor
                              Simulator (src/simulator.js) ── tractors, fuel, fields, interlocks
 Command Center dashboard (dashboard/) ◄──┘     Baseline FCFS dispatcher (src/baseline.js)

 Live mode (agopen/live.js): the same coordinator ── commands ──► 3 tractor processes ── WebSocket ──► 3 AgOpenWeb instances
                                                  ◄── telemetry ──┘  (faults detected from silence or no movement)
```

**Fleet Agent.** It plans by priority-first regret insertion, then local search with relocate, swap and eject-and-insert moves. Each candidate plan is scored by simulating every tractor's day with the same action rule the simulator executes (`src/model.js`): drive, swap implement, refuel, work. As a result the predicted plan matched the simulator to the minute in the no-event run.

**Hard constraints.** These are never broken:
- the right implement must be on board (a swap at the depot is planned when needed)
- fuel or battery never drops below a 10% reserve on any leg, with refuels inserted automatically
- the route must be reachable
- work must fit in the shift
- one tractor per job
- in-progress work is never pre-empted

**Objective.** The planner maximises on-time work weighted by priority × acres. It then minimises driving, finishes high-priority work early, avoids two tractors on one field at once, and keeps assignments stable across re-plans. A missed deadline costs most of a job's value. As a result, the planner only lets a job run late when an event makes that unavoidable. When it does, the job is flagged on the spot with the reason and the best achievable finish, and the operator can approve the late finish or drop the job.

**Re-planning.** The coordinator re-plans on every event: breakdown, repair, closure, reopening, priority change, new jobs, a dropped job, and each completed job.
- Completed work and partial progress are kept, down to the fraction of an acre.
- Only open work moves.
- The Safety Agent then re-checks the plan for duplicates, compatibility, fuel, deadlines, field conflicts and lost jobs before release. An unsafe plan is held, not executed.

**Explanations.** Every re-plan is logged with a headline, then what moved and why ("only working tractor with a sprayer", "T3 would miss the deadline", "+24 min detour via the north bridge"), then the before → after fleet finish time and the safety result. **Why?** for a job lists its slot, its slack against the deadline and its fuel at start. It also shows what each alternative tractor would have done: no implement, out of service, late, makes another job late, or extra driving.

**Baseline.** First come, first served: a free tractor takes the earliest-submitted unclaimed job it can do. It ignores priority and deadlines. It runs in the same simulator with the same routing and refuel rule, so the comparison is fair.

## Stretch goals covered
- [x] Blocked routes and changed priorities, as well as breakdowns (plus repairs, new jobs and dropped jobs)
- [x] Planning around fuel and battery levels: reserve-aware, with refuel stops inserted and a refuel-first rule so jobs aren't split by a mid-job refuel
- [x] Beats the FCFS baseline on completed work, deadlines, travel and idle time
- [x] Operator can ask "why?" about any assignment
- [x] AgOpenWeb integration: [`agopen/`](agopen/README.md). The coordinator talks to any simulator through a small dispatcher interface (`nextJob`, `onEvent`, `onJobDone`), so the same planner drives three AgOpenWeb tractors. Faults come from real telemetry; job progress still comes from the planner's simulator.

## Next: the agent team (experimental)

[`agents/`](agents/README.md) is a team of nine agents (Plan, Fleet, Fault, Route, Depot, Weather, Safety, Records and an Agronomy Advisor) on a durable runtime. They pass requests to each other, share memory, and speak at an operator "roundtable".

- **Sourced rules.** The Weather Manager acts on a playbook of sourced rules (National Weather Service, NOAA, university extension services). A rule with no checked source can only advise. The Agronomy Advisor follows the same rule: its field notes use each field's real soil survey unit and elevation, none has a cited source yet, so it only ever advises.
- **Ask the team.** `GET /ask?q=...` or `POST /ask` on port 5200 puts a question in plain words to the agent whose job it is: weather, fuel, faults, routes, the depot, safety, the plan, the day's record, or soil and crops. It answers from the live state with no key; with `ANTHROPIC_API_KEY` Claude writes the answer from the same facts and the agent's read-only tools. Asking never acts.
- **Randomised testing.** `node --test agents/test/fuzz.test.js` runs random days through the whole team: broken weather stations, unknown alerts, tractors that crowd each other or go silent, a runner that drops endpoints, restarts from the durable log, and questions. Eight invariants are checked after each day (nothing off the allowlist, a person's hold is never lifted, no side effect sent twice, every weather stop cites a verified rule, the Agronomy Advisor never acts, and more). 100 random days pass; `FUZZ_RUNS=200` runs more.

Status: the agents work together in their test suite (`node --test agents/test/`, against a fake runner). They are not yet wired into the live runner on `main`, which does not have the `/hold`, `/recall` and `/agent/say` endpoints they call, so they are not part of the scored demo.

## Limitations
- Travel is grid-based (4-connected) with flat per-tractor speeds. There are no slopes, turning time or road speed classes.
- A field is a single work point. The coverage path inside the field is not modelled; work time is acres ÷ rate.
- The planner is a heuristic, not an exact optimiser. In 10 of 200 random scenarios the baseline did slightly more on-time work.
- When a disruption makes the day impossible, late work goes ahead automatically (flagged) so the fleet keeps working. Set `"policy": {"lateWork": "hold"}` in the scenario to treat deadlines as strictly hard instead. On the demo day that gives 11 jobs on time, 0 late and 2 carried over to tomorrow.
