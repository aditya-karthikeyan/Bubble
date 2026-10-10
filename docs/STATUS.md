# Status

One row per role. Update your row at the end of every phase.

| Role                      | Person | Phase | State       | PR                                                  | Known issues                                                                                                                |
| ------------------------- | ------ | ----- | ----------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| P1 Core and Integration   | Aditya | 0     | done        | https://github.com/aditya-karthikeyan/Bubble/pull/1 | railway.json config-as-code deprecated 2026-12-01 (fine for the hackathon); deploys via `railway up` by P1 after each merge |
| P2 Messaging and Surfaces | Pranav | 0     | not started |                                                     |                                                                                                                             |
| P3 Bubbles and Context    | Soham  | 0     | not started |                                                     |                                                                                                                             |
| P4 Voice and Live Page    | Mahil  | 0     | not started |                                                     |                                                                                                                             |

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
