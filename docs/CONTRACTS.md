# Contracts

Single source of truth: `packages/shared/src`. This page is the map. The code is the law.
Any change under `packages/shared` needs P1 (Aditya) approval; open the PR and post a
CONTRACT team message.

## How to consume

```ts
import { PlanEvent, type MessagingPort, type Venue, SOCKET, newId } from '@bubbleworks/shared';
import {
  FakeMessaging,
  FakeBubbles,
  FakeCaller,
  FakeDoers,
  PERSONAS,
} from '@bubbleworks/shared/fakes';
```

`@bubbleworks/shared` exports TypeScript source (no build step). Node code runs through `tsx`.
Next.js (apps/web) needs `transpilePackages: ['@bubbleworks/shared']` in `next.config`.

Every domain type is a zod schema with the same name as its inferred type:
`Venue.parse(json)` validates, `Venue` as a type annotates.

## Ports (packages/shared/src/ports.ts)

| Port            | Owner | Implemented in                        | Fake                                      |
| --------------- | ----- | ------------------------------------- | ----------------------------------------- |
| `PlanEngine`    | P1    | `apps/server/src/engine` (Phase 1)    | none; use the sim CLI                     |
| `EventBus`      | P1    | `apps/server/src/events` (Phase 1)    | none; in-memory bus ships with the server |
| `MessagingPort` | P2    | `apps/server/src/adapters/spectrum`   | `FakeMessaging`                           |
| `BubbleService` | P3    | `apps/server/src/bubbles`             | `FakeBubbles` (five personas)             |
| `DoerPorts`     | P3    | `apps/server/src/doers`               | `FakeDoers`                               |
| `CallerPort`    | P4    | `apps/server/src/adapters/elevenlabs` | `FakeCaller` (booked after 3 s)           |

Rules that apply to every port:

1. Every outbound message and call carries `idempotencyKey`. Adapters treat a repeated key as a
   no-op and return the original result. Build keys with `idempotencyKey(planId, action, ...parts)`.
2. Every inbound handler tolerates duplicate events.
3. Inbound payloads (Spectrum events, webhooks, LLM output) are validated with zod at the boundary.
4. Adapters resolve provider handles to internal `userId`s before calling the engine.

### MessagingPort (P2)

Outbound: `sendGroupText`, `sendPrivateText`, `sendPoll`, `closePoll`, `sendRichLink`,
`editMessage`, `react`, `replyInThread`, `setTyping`, `renameGroup`, `setBackground`,
`upsertLiveCard`.
Inbound registration: `onGroupMessage`, `onPrivateMessage`, `onPollVote`, `onReaction`,
`onMemberChange`. Each returns an `Unsubscribe`.

Polls: the engine assigns `pollId` and option `key`s; `PollVote.choices` reports the keys the user
currently has selected (empty when cleared). Headcount is a poll of kind `headcount` with keys
`in` and `out`, or a 👍 reaction on the headcount message, whichever P2 finds works best on the line.

### BubbleService (P3)

`getProfile`, `getHardLimits`, `getSoftPrefs`, `getPresence`, `getLocation`, `getFreeBusy`,
`recordFact`, `onNewMember`, `onPrivateMessage`. Profiles are server-internal only. Nothing from a
profile reaches the page or another member.

### DoerPorts (P3)

`inviter.send`, `splitter.send`, `watcher.start`, `watcher.stop`. The engine fires inviter and
splitter on `booking_confirmed`, and watcher on the same event; watcher stops on `plan_closed`.

### CallerPort (P4)

`book`, `modify`, `cancel`, `holdTable`. Each returns a `CallHandle` immediately. Results arrive
asynchronously at `PlanEngine.handleCallResult(CallResult)`, from the ElevenLabs post-call webhook
or from the fake. `BookRequest.backupVenue` is tried when the primary declines or does not answer,
and the result reports `outcome: 'booked_backup'`. `depositRequested: true` means the engine must
get a human tap before anything is secured.

### PlanEngine (P1)

`handleIntent`, `handleVote`, `handleHeadcount`, `handleAskAnswer`, `handleMemberChange`,
`handleCallResult`, `handleCommand` (`wait`, `resume`, `cancel`, `veto`, `why`).

### EventBus (P1)

`publish(event)` persists, assigns `seq`, broadcasts to the plan's page room, and notifies
subscribers. `subscribe(planId | '*', handler)`. `replay(planId)` returns history in seq order.

## Events (packages/shared/src/events.ts)

`PlanEvent` is a zod discriminated union on `type`. Every event carries `type`, `planId`, `at`,
and (after publish) `seq`.

| Type                   | Payload                                                                | Emitted when                                   |
| ---------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| `plan_state_changed`   | from, to, reason?                                                      | every state transition                         |
| `bubble_joined`        | bubble {userId, displayName, status}                                   | member marked in, or represented               |
| `bubble_left`          | userId, reason                                                         | out, dropped, left group                       |
| `candidate_added`      | venue {venueId, name, cuisine}                                         | candidate enters the solver                    |
| `round_complete`       | round, scores[{userId, venueId, score 0..1}], bubbles[], leaderVenueId | each solver round                              |
| `candidate_eliminated` | venueId, round, reason                                                 | least support, infeasible, closed, vetoed      |
| `bubble_merged`        | userIds, venueId                                                       | bubbles agree on one venue                     |
| `private_ask_sent`     | askId                                                                  | concession ask sent (no who, no what)          |
| `private_ask_resolved` | askId, outcome                                                         | accepted, declined, expired, cancelled         |
| `plan_locked`          | venue, backup, startAt, partySize                                      | winner certain                                 |
| `doer_status`          | doer, state, detail?                                                   | caller, inviter, splitter, watcher progress    |
| `booking_confirmed`    | bookingId, venue, startAt, partySize, reservationName                  | call ended booked                              |
| `plan_closed`          | reason                                                                 | completed, cancelled, failed, too_few, expired |

Page-visible payloads never contain budgets, distances, diets, allergies, accessibility needs,
locations, or ask contents. Bubble status on the page is only `fits`, `stretching`,
`holding_firm`, or `represented`. `events.test.ts` enforces the forbidden key list.

## Socket.io (apps/server <-> apps/web)

Namespace `/live`. Constants in `SOCKET`.

| Direction        | Event        | Payload     | Ack                                   |
| ---------------- | ------------ | ----------- | ------------------------------------- |
| client -> server | `join`       | `{ token }` | `{ ok, error?, replay: PlanEvent[] }` |
| client -> server | `ping`       | none        | `{ pong: true, at }`                  |
| server -> room   | `plan_event` | `PlanEvent` | none                                  |

Rooms are `plan:<token>`. Tokens are 128-bit random (`newPageToken()`), expire two hours after
the plan closes, and an unknown token gets `{ ok: false }`.

## Constants (packages/shared/src/constants.ts)

`DEADLINES` and `DEMO_DEADLINES` (DEMO_MODE), `SPEED_TARGETS_MS`, `PLAN_MESSAGE_BUDGET` (8),
`MIN_AGGREGATE_GROUP_SIZE` (3), `MIN_PARTY_SIZE` (2), `CONCESSION_STEPS`, `MODELS`, `SOCKET`,
`TIMING_MARKS`.

## Personas (packages/shared/src/fakes/personas.ts)

Stable ids used by every fake, the seed script, and the demo reset: `group_demo` / `chat_demo`,
`user_ava` (vegetarian, $25), `user_ben` (peanut allergy, $40), `user_chloe` (halal, $20),
`user_dev` (no limits, $50, favorite `venue_demo`), `user_eli` (wheelchair, $30).

## Server internals (P1, apps/server/src)

Not contracts, but the pieces other roles call from inside the server process:

| Module                     | What it gives you                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `runtime.ts` createRuntime | db, `bus` (SqliteEventBus), `timers`, `plans` (PlanStore), `candidates` (CandidateIndex)     |
| `engine/state-machine.ts`  | `canTransition(to, ctx)`, transition table, `IllegalTransitionError`, `isTerminal`           |
| `engine/plan-store.ts`     | `create`, `transition` (persists + audits + publishes `plan_state_changed`), members, budget |
| `events/bus.ts`            | `publish`, `subscribe`, `replay`, `replayForToken` (null when unknown or expired)            |
| `timers/service.ts`        | `schedule({ planId, kind, payload, delayMs? })`, `on(kind, handler)`, `cancel`, `pending`    |
| `venues/candidates.ts`     | `forGroup({ groupId, date, startMinutes, memberIds })`, `invalidate(groupId)`                |
| `venues/compat.ts`         | `isCompatible(venue, facts)` for diet, allergy, religious_diet, accessibility                |
| `db/seed.ts`               | idempotent seed of personas, demo group (center: Fetzer Gym), data/venues.json               |

Timer kinds: `poll_deadline`, `ask_timeout`, `veto_window`, `call_timeout` use `DEADLINES` (or
`DEMO_DEADLINES` when DEMO_MODE); `day_of`, `page_token_expiry`, `custom` take `delayMs`.
Timers live in SQLite and fire after a restart.

Venue conventions: `dietTags` may include `<allergen>_free`; `accessibilityTags` is
`wheelchair` / `step_free` / `no_wheelchair` (absent means unknown and passes). The demo venue
is `venue_demo`; its phone comes from `DEMO_VENUE_PHONE`, never from the repo.

P3: `createRuntime({ hardFacts })` is where `BubbleService.getHardLimits` replaces the facts
table read in Phase 3.

## Invariants every module keeps

1. No bubble reveals another person's constraint anywhere.
2. Aggregates only across three or more people.
3. Allergies, religious diets, accessibility needs are never relaxed (`NEVER_RELAX_FACT_TYPES`).
4. Nothing booked, paid, or deposited without a human tap or an expired veto window.
5. Every call opens with an AI disclosure.
6. "wait" pauses; "forget that" / "forget me" delete.
7. Focus state sets quiet hours.
8. Each plan has a message budget (`PLAN_MESSAGE_BUDGET`).
