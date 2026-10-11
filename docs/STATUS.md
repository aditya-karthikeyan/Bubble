# Status

One row per role. Update your row at the end of every phase.

| Role                      | Person | Phase | State       | PR                                                   | Known issues                                                                                                                                                                                                                          |
| ------------------------- | ------ | ----- | ----------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 Core and Integration   | Aditya | 5     | in progress | Phases 0-4 merged (#20); Phase 5 PR (demo reset)     | OSM wheelchair tags mostly missing (unknown passes, caller confirms); halal satisfied by vegetarian-capable venues; deploy to Railway after merge                                                                                     |
| P2 Messaging and Surfaces | Pranav | 4     | in review   | https://github.com/aditya-karthikeyan/Bubble/pull/18 | Quiet hours need index.ts: messaging.setPresence(id => bubbles.service.getPresence(id)). Phase 3: #16. Red team: 10/10 probes refused, 0 leaks.                                                                                       |
| P3 Bubbles and Context    | Soham  | 3     | in review   | #9, #11 merged; Phase 3 PR pending                   | Phone checks (onboarding, invite, Venmo, represented summary) need Railway + LINE LOCK; Inviter uses an .ics link (no attachment send on MessagingPort); lateness calls caller.holdTable from index.ts until the engine has a handler |
| P4 Voice and Live Page    | Mahil  | 0     | not started |                                                      |                                                                                                                                                                                                                                       |

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
