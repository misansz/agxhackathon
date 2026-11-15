# Farm Manaigment: 5-minute pitch script for 4 speakers

Slides: [slides.pdf](slides.pdf), or open [slides.html](slides.html) in a browser. Speaker notes are in the HTML source, in each slide's `<aside>`.

Each line is tagged with the part of the ATC brief it answers. Total is about 4 min 45 s, which leaves 15 s of slack.

| Time | Speaker | Slides | Covers |
| --- | --- | --- | --- |
| 0:00 to 0:50 | Speaker 1 | 1 Cover, 2 Problem, 3 Market | The problem and why it matters |
| 0:50 to 3:10 | Speaker 2 | 4 What we built, 5 The brief, live demo | All five must-haves, shown live |
| 3:10 to 4:05 | Speaker 3 | 6 Spray or Wait, 7 AI team | Track 1, and the agent layer |
| 4:05 to 4:50 | Speaker 4 | Stays on 7 AI team | The five judged rows and the tiebreaker, spoken |

---

## Speaker 1: the problem and the market (0:00 to 0:50)

**Slide 1, Cover (10 s)**

"We are Team 5, and this is Farm Manaigment: fleet management for autonomous tractors. It knows your farm, checks your fields, builds the day's schedule, and keeps AI watching every factor while the work runs."

**Slide 2, Problem (15 s)** *[Brief: the problem]*

"Autonomous tractors can do the field work. Someone still has to decide which tractor does which job, and what happens when a machine breaks, the air turns against spraying, or priorities change. Today that is done by hand, or first come, first served, which misses deadlines without warning anyone."

**Slide 3, Market (25 s)**

"This matters now. Precision farming is a 12.8 billion dollar market heading to 21 billion by 2030. Autonomous tractors are about 3.9 billion and growing 16 percent a year. Meanwhile farms cannot find people: certified H-2A positions went from 85 thousand to 379 thousand in twelve years. And it is local. Yuma grows about 90 percent of the country's winter leafy greens, and our demo farm sits in the Yuma Valley. More machines, fewer people: someone has to coordinate the fleet."

Hand over: "Here is what we built."

---

## Speaker 2: the product and the live demo (0:50 to 3:10)

**Slide 4, What we built (20 s)** *[Must-have 3: show progress]*

"This is the live status page. It knows your farm: every field has a record of its crop, planting date and ground state. It has the tools to check: a scout drone and telemetry four times a second. It builds the schedule, and AI managers watch the whole day."

**Slide 5, The brief (10 s)**

"You asked for five must-haves and five stretch goals. They are all done. Rather than read them, we will show you."

**Switch to the status page at http://localhost:5190 (1 min 50 s)**

1. **Add a job (15 s)** *[Must-have 1: take a job list]*
   Click a field, click Spray, press Add to list.
   "An operator submits jobs here. The rules are a foreman's rules: it refuses to sow a field that has not been plowed, and tells you why."

2. **Point at the fleet cards (20 s)** *[Must-have 2: compatible tractors. Rubric: constraint compliance]*
   "Each job goes to a tractor with the right implement, enough fuel and time before the deadline. Fuel never drops below a 10 percent reserve. A refuel or an implement change locks the tractor until a person presses Good to go."

3. **Point at the map (10 s)** *[Must-have 3: show progress. Stretch: AgOpenWeb]*
   "Each vehicle is a real AgOpenWeb instance. The map shows live GPS and the ground already worked."

4. **Break a tractor (45 s)** *[Must-have 4: recover from a breakdown. Rubric: adaptation to events]*
   Type `stuck` in T1's Terminal window, or press the fault button on its card.
   "I am stalling T1. The coordinator is not told. It works it out from telemetry: told to go, and not moving."
   Wait for the fault to show.
   "T1 is out of service. Its unfinished job goes to another tractor, which carries on from the passes already done. No job is held by two tractors, and no finished work is lost."

5. **Read the plan change, then press Why? (20 s)** *[Must-have 5: explain the new plan. Stretch: ask why]*
   Point at the Latest plan change card, then press Why? on the moved job.
   "Here is what moved and why, in plain language. And for any job you can ask why: the reasons, and the alternatives it rejected."

Hand over: "That same run also answers a second track."

---

## Speaker 3: Spray or Wait, and the AI team (3:10 to 4:05)

**Slide 6, Spray or Wait (30 s)** *[Track 1. Rubric: constraint compliance]*

"We also solved Track 1, Spray or Wait, in the same system. While a tractor sprays, a drone flies above it and reads the wind at 10, 30 and 50 metres. The coordinator reads the air at two heights every minute and checks for an inversion, wind and shear. The answer is Go, Caution or Stop, with the reason and the numbers. In this capture a ground station alone would have said Go. The second height caught the inversion, and every spray job was held where it stood."

**Slide 7, AI team (25 s)** *[Brief: agent-based orchestrator. Rubric: explanations]*

"Behind this is a team of AI managers, one job each. They share one memory: every manager reads all of it and writes only its own part, and everything goes to one log file. On every event they talk it through at a roundtable you can read on the dashboard, and the chair decides: change a priority, approve a late finish, or defer a job. None of them can release a tractor. A person does that."

Hand over: "So how does it score?" Leave slide 7 on screen.

---

## Speaker 4: the numbers and the close (4:05 to 4:50)

**No slide of your own. Slide 7 stays up (45 s)** *[All five judged rows, the baseline comparison and the tiebreaker]*

There is no scorecard on screen, so say each row's name clearly and pause after each number. Count the rows on your fingers if it helps the judges follow.

"You score five things, so here they are, same farm and same events for us and for first come, first served.
One, constraint compliance: zero unannounced violations in 200 random scenarios. The baseline had 346.
Two, completed work: 13 of 13 jobs on the demo day. The baseline finished 10.
Three, adaptation: every re-plan in 9 milliseconds or less, with no acre lost or worked twice.
Four, efficiency: 26 percent less travel, and zero idle minutes on the breakdown day against 22.
Five, explanations: a plain-language reason for every change, and Why? on every job, as you just saw.

Your tiebreaker asks whether a farm operator would trust this plan. Every change is explained, a person does the fuelling, and nothing is hidden. Thank you."

If a judge wants to see the numbers, open `out/comparison.md` and `agopen/test/TEST_REPORT.md`.

---

## If a judge asks

- **Is the AI making the decisions?** The algorithmic planner assigns and re-plans. The AI managers explain, discuss and can change priorities, approve a late finish or defer a job. They never move a tractor.
- **What is simulated?** The GPS is AgOpenWeb's built-in simulator. Fuel, the plan clock, the weather feed and the drone are simulated. Each vehicle is a real AgOpenWeb instance.
- **Does the drone decide Go or Stop?** No. The decision uses the two mast heights, 2 m and 10 m. The drone's readings at 10, 30 and 50 m are shown beside it.
- **Where is the shared memory?** In the agent runtime in `agents/`: key-value memory with history, and a durable log. The roundtable on the status page shares the event facts and the message trail.
- **Does it ever lose to the baseline?** Yes. The planner is a heuristic, and in 10 of 200 random scenarios the baseline did slightly more on-time work. It never broke a constraint silently.
- **Where are the hand-in items?** Code and README in the repo, `scenario.json` and `agopen/scenario.live.json`, the event log in `out/` and `agopen/handin/`, and the baseline comparison in `out/comparison.md` and `agopen/test/TEST_REPORT.md`.

## Before you start

- Have the status page open with the day already running, so the demo starts with tractors moving.
- Know which Terminal window is T1.
- If the demo fails, stay on slide 5, read three must-haves, and go to slide 6. The fallback tabs are `out/comparison.md` and `agopen/test/TEST_REPORT.md`.
- Market figures are third-party estimates (BCC Research, IMARC, Farm Bureau, University of Arizona). Say "about" when quoting them.
