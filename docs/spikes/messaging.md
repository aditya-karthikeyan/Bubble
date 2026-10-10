# Spike: messaging (P2)

Photon docs version: Stable. spectrum-ts 12.10.1, @photon-ai/advanced-imessage 2.2.0, Photon CLI 2.2.0.
Project: Bubbleworks (`70aebcee-3d89-410a-af3d-f745fcc69d7e`), plan Pro via promo HACKWITHPHOTON.
Tested 2026-10-10 on real iPhones (Pranav, Mahil). Spike code lives in a scratch folder
(`bubbleworks-p2-spike`); the reusable parts move into `apps/server/src/messaging` in Phase 1.

## Headline: Pro cannot be in a group chat

Pro uses Photon's shared pool. Business ($250/mo) gives a dedicated line.

| Test                                                 | Result                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| `photon spectrum lines add`                          | 403 "Line add/remove is only available on the business plan"     |
| Agent messages a registered user who never texted in | "Target not allowed for this project"                            |
| Each registered user's agent number                  | Different per user (Pranav +16465792852, Mahil +16282647754)     |
| User texts another user's bubble number              | Never reaches the app                                            |
| Group of Pranav + Mahil + Pranav's bubble number     | App receives nothing from the group                              |
| Spectrum SIP voice                                   | Needs a project-owned line as caller ID, so not available on Pro |

Decision (Pranav): crew over DMs. Every person texts their own bubble number, declares their crew
there, and the server fans plan messages out to each member's DM. The live page is the shared
view. Voice goes through ElevenLabs + Twilio. See the CONTRACT message in docs/team-log/P2.md.

## Capability matrix (DM, shared pool)

Latency columns: send = time until the SDK call resolved; inbound = phone timestamp to receipt.

| Primitive                                     | Works          | Latency                                                           | Notes                                                                             |
| --------------------------------------------- | -------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Inbound text                                  | yes            | 1.0 to 2.9 s; 5 to 6 s on the first message of a new conversation |                                                                                   |
| Outbound text                                 | yes            | about 2 s                                                         | only after the user has texted their bubble once                                  |
| Agent-started DM later in the day             | yes            |                                                                   | conversation must already exist                                                   |
| Typing indicator                              | yes            | about 1.5 s per start/stop call                                   | fire and forget, don't await on the hot path                                      |
| Edit text in place                            | yes            | 0.5 s                                                             | basis for the live status card                                                    |
| Rich link                                     | yes            | about 2.8 s                                                       | Spectrum sends the URL only; the preview comes from the page's Open Graph tags    |
| App card (generic `app()`)                    | yes            | 2.0 s                                                             | opens in the "Spectrum by Photon" iMessage app; no Apple Developer account needed |
| Customized iMessage app card                  | not tried      |                                                                   | needs Apple Team ID + extension bundle id; nobody on the team needs it            |
| Message effect (confetti)                     | yes            | 0.5 s                                                             |                                                                                   |
| Tapback in (👍)                               | yes            | 1.0 s inbound                                                     | `reaction` content with `target.id` = our message id                              |
| Tapback out                                   | yes            |                                                                   |                                                                                   |
| Threaded reply in / out                       | yes            | 1.4 to 2.9 s inbound                                              | inbound arrives as `reply` content wrapping text                                  |
| Poll send                                     | yes            |                                                                   |                                                                                   |
| Poll vote in                                  | yes with patch | 0.9 to 1.3 s                                                      | stock SDK drops every vote, see below                                             |
| Poll vote change                              | yes with patch |                                                                   | arrives as `+Sushi` then `-Thai`; keep per-voter state                            |
| Poll edit / close                             | no             |                                                                   | "Unknown server error"; send "Voting closed: X" instead                           |
| Mark read (agent)                             | yes            | 1.1 s                                                             | marks the whole chat                                                              |
| Inbound read receipt                          | yes in DMs     | 0.9 s                                                             | group receipts are best-effort per docs                                           |
| Delivery status (`isDelivered`)               | not observed   |                                                                   | never set within 15 s on the shared pool                                          |
| Group rename, background, avatar, membership  | n/a            |                                                                   | groups unsupported on Pro                                                         |
| Advanced iMessage `addresses.isFocusSilenced` | yes            |                                                                   | read-only, no line lock needed                                                    |
| Advanced iMessage `locations.get(address)`    | routes         |                                                                   | "not currently sharing" until the person shares Find My with their bubble number  |
| Advanced iMessage `locations.list()`          | no             |                                                                   | "No instance routed" on the shared pool                                           |

## Gotchas

1. **Poll votes are dropped by spectrum-ts 12.10.1.** Apple echoes our poll with an empty title,
   `asPoll` rejects it (zod min length 1), the SDK logs "failed to cache poll" and "failed to
   resolve poll", and the vote never reaches `app.messages`. Fix: `pnpm patch` on
   `@spectrum-ts/imessage@12.10.1`, `title: input.title || "Poll"` in `toCachedPoll`. The patch
   moves into the repo with the adapter in Phase 1. Report upstream to Photon.
2. **Allowlist.** On Pro a recipient must be registered as a Spectrum user (first name, last name,
   email, phone: all required by the CLI and API) and must text their bubble number first.
   Registering an existing phone updates that user (upsert by phone).
3. **Registration API.** `POST https://spectrum.photon.codes/projects/{id}/users/` with HTTP Basic
   (project id, project secret). `GET` on the same path lists users, including each
   `assignedPhoneNumber`, which is the person's bubble number.
4. **Advanced iMessage on Pro.** No static address or token. `cloud.issueImessageTokens(id,
secret)` (exported by spectrum-ts) returns a shared token valid 900 s; address
   `imessage.spectrum.photon.codes:443`; client `createGrpcClient` from
   `@photon-ai/advanced-imessage/grpc` with `tls: true`.
5. **Shared mode has one gateway client**, so new users need no restart. The SDK's gRPC client sets
   `autoIdempotency: true`, but the public `space.send` API takes no idempotency key; our outbox
   keeps its own keys.
6. **Terminal provider** skips `poll`, `richlink`, and `edit` with a warning. The fake path needs
   text fallbacks: numbered poll options, links as text, edits re-sent as new lines.
7. **First message rule (deliverability).** No links or media in the first message to a new
   person. Pace sends; Apple flags bursts, cold outreach, and 3 am messages.
8. **Quotas.** 5,000 outbound per server per day, 50 new conversations per line per day.
9. **Only one process may consume the message stream.** Read-only Advanced iMessage calls
   (addresses, locations) do not need a LINE LOCK; anything that reads messages or events does.

## Line lock rules

- Only one process connects to `app.messages` at a time. Local development uses
  `SPECTRUM_PROVIDER=terminal`.
- Post LINE LOCK before connecting with `SPECTRUM_PROVIDER=imessage`, LINE RELEASE after.
- From Checkpoint B onward only the Railway server holds the line.

## Docs

- https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing (line model)
- https://photon.codes/docs/spectrum-ts/troubleshooting/imessage ("Target not allowed")
- https://photon.codes/docs/best-practices/imessage-deliverability
- https://photon.codes/docs/advanced-kits/imessage/addresses, /locations
