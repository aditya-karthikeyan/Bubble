# Status

One row per role. Update your row at the end of every phase.

| Role                      | Person | Phase | State       | PR                                                  | Known issues                                                                                                                                                                       |
| ------------------------- | ------ | ----- | ----------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 Core and Integration   | Aditya | 2a    | in review   | PR #2 (Phase 1), PR #4 (crew contract)              | OSM wheelchair tags mostly missing (unknown passes, caller confirms); halal satisfied by vegetarian-capable venues; deploy to Railway after merge                                  |
| P2 Messaging and Surfaces | Pranav | 1     | in review   | https://github.com/aditya-karthikeyan/Bubble/pull/5 | Tapback removal not exposed by spectrum-ts. Server wiring (createMessaging in index.ts, POST /api/signup) left to P1. Phase 0: https://github.com/aditya-karthikeyan/Bubble/pull/3 |
| P3 Bubbles and Context    | Soham  | 1     | in review   | PR #6 (Phase 0), PR #9 (Phase 1)                    | Phone onboarding check waits on PR #5 + createBubbles wiring in index.ts; presence/location/free-busy are Phase 2 stubs; Focus unusable on Pro (command + calendar fallback)       |
| P4 Voice and Live Page    | Mahil  | 0     | not started |                                                     |                                                                                                                                                                                    |

## Checkpoints

| Checkpoint                                                  | Hour | Result |
| ----------------------------------------------------------- | ---- | ------ |
| A: poll + headcount + link within 5 s, solver logs a winner | 9    |        |
| B: real call ends in "Booked"                               | 15   |        |
| C: edge cases and safety pass                               | 19   |        |
| Final: five rehearsals, backups recorded                    | 23   |        |

## Deployments

| Service          | URL                                           |
| ---------------- | --------------------------------------------- |
| Railway server   | https://server-production-6ba5.up.railway.app |
| Vercel live page |                                               |

## Line lock

Holder of the real iMessage line: nobody (local development uses the Spectrum terminal provider).
