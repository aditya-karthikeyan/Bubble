# Status

One row per role. Update your row at the end of every phase.

| Role                      | Person | Phase | State       | PR                                                                                                    | Known issues                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | ------ | ----- | ----------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 Core and Integration   | Aditya | 5     | in progress | Phases 0-4 merged (#20); Phase 5 PR (demo reset)                                                      | OSM wheelchair tags mostly missing (unknown passes, caller confirms); halal satisfied by vegetarian-capable venues; deploy to Railway after merge                                                                                                                                                                                      |
| P2 Messaging and Surfaces | Pranav | 4     | in review   | https://github.com/aditya-karthikeyan/Bubble/pull/18                                                  | Quiet hours need index.ts: messaging.setPresence(id => bubbles.service.getPresence(id)). Phase 3: #16. Red team: 10/10 probes refused, 0 leaks.                                                                                                                                                                                        |
| P3 Bubbles and Context    | Soham  | 4     | in review   | #9, #11 merged; #15 (Phase 3), Phase 4 PR pending                                                     | Phone checks wait on Railway + LINE LOCK; venue-level dislike stored as other=avoid_venue:<id> until FactType has one; Inviter uses an .ics link                                                                                                                                                                                       |
| P4 Voice and Live Page    | Mahil  | 3     | in review   | #24 (caller), #47 (live + landing) merged; p4/voice-preview-status (Jessica voice, iMessage previews) | Real mode rings only the demo venue + CALLER_ALLOWED_NUMBERS, and since #48 the demo venue wins only on an American vote or no vote (demo switch pending); Twilio trial notice + keypress opens every call; AI line off on Railway (CALLER_DISCLOSE=false); restaurant callbacks unhandled; modify/cancel/hold untested on a real call |

## Checkpoints

| Checkpoint                                                  | Hour | Result                                                                                                                                                  |
| ----------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: poll + headcount + link within 5 s, solver logs a winner | 9    | PASS 2026-10-11 01:38 UTC, 3 real phones: typing 1 ms, detect 7 ms, bundle 4.8 s after receipt, lock 62.7 s (60 s demo poll), Booked 82 s (fake caller) |
| B: real call ends in "Booked"                               | 15   |                                                                                                                                                         |
| C: edge cases and safety pass                               | 19   |                                                                                                                                                         |
| Final: five rehearsals, backups recorded                    | 23   |                                                                                                                                                         |

## Deployments

| Service          | URL                                           |
| ---------------- | --------------------------------------------- |
| Railway server   | https://server-production-6ba5.up.railway.app |
| Vercel live page | https://bubbleworks-eosin.vercel.app          |

## Line lock

Holder of the real iMessage line: **Railway** (SPECTRUM_PROVIDER=imessage since 2026-10-11 01:19 UTC, P2 LINE LOCK). Nobody runs the imessage provider locally. DEMO_MODE=true on Railway for rehearsals.
