# Status

One row per role. Update your row at the end of every phase.

| Role                      | Person | Phase | State       | PR                                                   | Known issues                                                                                                                                                                                               |
| ------------------------- | ------ | ----- | ----------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 Core and Integration   | Aditya | 2     | in review   | Phase 2 PR (solver, engine, sim); #1 #2 #4 #8 merged | OSM wheelchair tags mostly missing (unknown passes, caller confirms); halal satisfied by vegetarian-capable venues; deploy to Railway after merge                                                          |
| P2 Messaging and Surfaces | Pranav | 2     | in review   | https://github.com/aditya-karthikeyan/Bubble/pull/7  | Real-line: typing 1 ms, poll 2.4 s, bundle 3.1 s after receipt (+~1-1.5 s Apple lag). Waits on P1 engine wiring (attachEngine, renderBundle). Phase 0 #3, Phase 1 #5.                                      |
| P3 Bubbles and Context    | Soham  | 2     | in review   | #9 merged (Phase 0+1), Phase 2 PR pending            | Phone onboarding check needs Railway deploy + LINE LOCK; Find My/free-busy cold reads miss the 300 ms budget and serve cache (prefetch at plan start); Focus unusable on Pro (command + calendar fallback) |
| P4 Voice and Live Page    | Mahil  | 0     | not started |                                                      |                                                                                                                                                                                                            |

## Checkpoints

| Checkpoint                                                  | Hour | Result                                                                    |
| ----------------------------------------------------------- | ---- | ------------------------------------------------------------------------- |
| A: poll + headcount + link within 5 s, solver logs a winner | 9    | sim: bundle 21 ms, lock 34 ms after intent; real-line run with P2 pending |
| B: real call ends in "Booked"                               | 15   |                                                                           |
| C: edge cases and safety pass                               | 19   |                                                                           |
| Final: five rehearsals, backups recorded                    | 23   |                                                                           |

## Deployments

| Service          | URL                                           |
| ---------------- | --------------------------------------------- |
| Railway server   | https://server-production-6ba5.up.railway.app |
| Vercel live page |                                               |

## Line lock

Holder of the real iMessage line: nobody (local development uses the Spectrum terminal provider).
