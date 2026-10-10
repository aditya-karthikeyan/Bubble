# P3 context spike (Phase 0)

Spike code: apps/server/scripts/p3/ (run `pnpm p3:phase0`). Owner: P3 Soham.

## Status

| Check                       | State                                                    | Notes                                                       |
| --------------------------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| Haiku structured JSON + zod | WORKS (4.2 s cold call)                                  | `messages.parse` + `zodOutputFormat`, re-validated with zod |
| Calendar free/busy OAuth    | WORKS (freeBusy 183 ms)                                  | scope calendar.freebusy, localhost:3000 callback            |
| Find My location            | WORKS (7.0 s call, fix 8 s old, shallow, coords present) | `im.locations.get(address)`                                 |
| Focus presence              | FAILS for our use: always false with the member's DND on | `im.addresses.isFocusSilenced(address)`; fallback chosen    |

## Findings

- Phase 0 started in a scratch folder (bubbleworks-p3-spike) while the repo was empty; moved here after MAIN UPDATED 68cd1e5.
- `@photon-ai/advanced-imessage` is v2.2.0. The docs' `createClient` (gRPC) is a deprecated v1 alias; root export is now `createHttpClient({ address, token })`. Docs lag the SDK.
- Focus is a boolean only (`isFocusSilenced`). It cannot tell focus vs sleep vs driving apart. The role prompt's presence states (focus, sleep, driving) need a fallback for sleep/driving.
- Docs say `isFocusSilenced` reports the recipient's Focus; the SDK's JSDoc says "whether this device's Focus settings would silence notifications from the address". The DND on/off test decides which is true.
- Location updates are not in the durable event log; `watch()` misses updates while disconnected. Watcher must poll `get()` or reconnect.

## Assumptions

- ASSUMPTION: presence = `represented` when `isFocusSilenced` is true OR a calendar busy block covers now OR the user sent a private "busy" command. Sleep is inferred from local time 23:00 to 07:00 plus silenced; driving is not detectable and is treated as focus.
- ASSUMPTION: "tonight" for free/busy = 17:00 to 23:59 local time.
- ASSUMPTION: the team Anthropic key is created in P1 Aditya's console org (it holds the credits), not by P3. P3 still distributes it privately and manages usage.
- ASSUMPTION: Haiku model id stays `claude-haiku-4-5-20251001` per the God Prompt.

## Fallbacks (if a signal fails)

- Location: onboarding neighborhood.
- Presence: calendar busy blocks plus a private "busy" command.

## Gotchas

- Google OAuth app is External + Testing: every user (teammates, judges) must be added under Audience → Test users first, or Google returns 403 access_denied.
- Long OAuth URLs get truncated when clicked from a terminal (lost response_type). Always hand out a short start URL (/oauth/google/start) that 302s to Google. The product's onboarding link should do the same.
- Haiku extraction cold call took 4.2 s. Fine for the background worker; keep it off the 5 s plan path.
- All teammates added as OAuth test users (2026-10-10). Judges still to add before the demo.

## Pro signal latency (2026-10-10, Mahil's number)

- Token mint via cloud.issueImessageTokens + createGrpcClient works.
- isFocusSilenced: 7.9 s, 5.5 s, 5.4 s. isIMessageAvailable: 11.3 s. Far over the 300 ms signal budget.
- Decision: presence is never fetched inline. A background refresher polls isFocusSilenced per crew member (every 2 min, every 60 s during an active plan), and getPresence reads the cache only. Cache age is logged.
- "Target not allowed for this project" = address is not a registered Spectrum user. Use the registered E.164 phone, not an email.
- "Address is not currently sharing a location" (NotFoundError) = no Find My share with that person's bubble number yet.
- locations.get after Mahil shared Find My with his bubble number: ok, 7.0 s call, locationType "shallow", fix 8 s old, coordinates present, shortAddress null. Location also needs the background cache (Watcher polls every 60 s, so a 7 s call fits).
- Focus with DND off: false (6.8 s).

## Focus verdict (2026-10-10)

- Mahil: Do Not Disturb ON, Settings → Focus → Focus Status → Share Focus Status ON (always was). isFocusSilenced returned false on 6 calls over ~10 minutes (6 to 25 s each).
- Conclusion: on Pro, isFocusSilenced does not reflect a member's own Focus. Consistent with the SDK JSDoc ("whether this device's Focus settings would silence notifications from the address"), i.e. the line's device. The docs' "recipient is silencing" reading is wrong for our use.
- DECISION (fallback): presence comes from
  1. a private command to the bubble: "busy" / "focus" -> focus, "sleeping" / "bed" -> sleep, "driving" -> driving, "back" / "free" -> available. Expires after 3 h or at 07:00 local for sleep.
  2. a Google Calendar busy block covering now -> focus.
  3. local time 23:00 to 07:00 with no recent DM -> sleep (quiet hours).
  4. otherwise available; unknown when we have no calendar and no command.
- Demo impact: the "teammate turns on DND" moment becomes "teammate texts their bubble 'busy'" (or has a calendar event at demo time). Tell P1 and P4 (demo direction).
- isFocusSilenced stays out of the plan path entirely.
