# Status

One row per role. Update your row at the end of every phase.

| Role                      | Person               | Phase | State      | PR                                                                                                    | Known issues                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | -------------------- | ----- | ---------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 Core and Integration   | Aditya               | 5     | demo ready | Everything on main is deployed (#56 to #88)                                                           | Agent-first flow (FLOW=agent_first): one message, which-crew + cuisine question, 👍 headcount, live Google Places venues (sit-down, reviews count), lock, call to the demo phone, Mini App ticket card -> Aero ticket page, invite with maps + .ics, payer-driven split. Demo clock 16:00. Twilio trial: callee presses a key first. Share My Location is unsupported by Photon; pins work. |
| P2 Messaging and Surfaces | Aditya (Pranav left) | 5     | demo ready | merged into main through P1 PRs                                                                       | Conversational intake (draft question, never silent), crews by join link, Mini App card transport, server-hosted /join and /t pages. Organizer-only live view: /watch/<secret>.                                                                                                                                                                                                             |
| P3 Bubbles and Context    | Soham                | 4     | in review  | #9, #11 merged; #15 (Phase 3), Phase 4 PR pending                                                     | Phone checks wait on Railway + LINE LOCK; venue-level dislike stored as other=avoid_venue:<id> until FactType has one; Inviter uses an .ics link                                                                                                                                                                                                                                            |
| P4 Voice and Live Page    | Mahil                | 3     | in review  | #24 (caller), #47 (live + landing) merged; p4/voice-preview-status (Jessica voice, iMessage previews) | Real mode rings only the demo venue + CALLER_ALLOWED_NUMBERS, and since #48 the demo venue wins only on an American vote or no vote (demo switch pending); Twilio trial notice + keypress opens every call; AI line off on Railway (CALLER_DISCLOSE=false); restaurant callbacks unhandled; modify/cancel/hold untested on a real call                                                      |

## Checkpoints

| Checkpoint                                                  | Hour | Result                                                                                                                                                       |
| ----------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A: poll + headcount + link within 5 s, solver logs a winner | 9    | PASS 2026-10-11 01:38 UTC, 3 real phones: typing 1 ms, detect 7 ms, bundle 4.8 s after receipt, lock 62.7 s (60 s demo poll), Booked 82 s (fake caller)      |
| B: real call ends in "Booked"                               | 15   | PASS 2026-10-11 07:17 UTC: "dinner with the boys, feeling indian" -> Taal Dining booked by the ElevenLabs agent (demo phone) in 96 s; repeated 6 times since |
| C: edge cases and safety pass                               | 19   | PASS 2026-10-11 10:05 UTC: veto re-lock, deadlock stretch ask (yes in 10 s), call failure fallback to backup, already-booked reply, split on real phones     |
| Final: five rehearsals, backups recorded                    | 23   |                                                                                                                                                              |

## Deployments

| Service          | URL                                           |
| ---------------- | --------------------------------------------- |
| Railway server   | https://server-production-6ba5.up.railway.app |
| Vercel live page | https://bubbleworks-eosin.vercel.app          |

## Line lock

Holder of the real iMessage line: **Railway** (SPECTRUM_PROVIDER=imessage since 2026-10-11 01:19 UTC, P2 LINE LOCK). Nobody runs the imessage provider locally. DEMO_MODE=true on Railway for rehearsals.
