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

| Port            | Owner | Implemented in                           | Fake                                       |
| --------------- | ----- | ---------------------------------------- | ------------------------------------------ |
| `PlanEngine`    | P1    | `apps/server/src/engine` (Phase 1)       | none; use the sim CLI                      |
| `EventBus`      | P1    | `apps/server/src/events` (Phase 1)       | none; in-memory bus ships with the server  |
| `MessagingPort` | P2    | `apps/server/src/adapters/spectrum`      | `FakeMessaging`                            |
| `BubbleService` | P3    | `apps/server/src/bubbles`                | `FakeBubbles` (five personas)              |
| `DoerPorts`     | P3    | `apps/server/src/doers`                  | `FakeDoers`                                |
| `CallerPort`    | P4    | `apps/server/src/adapters/elevenlabs`    | `FakeCaller` (booked after 3 s)            |
| `CrewDirectory` | P1    | `apps/server/src/crew` (DbCrewDirectory) | `FakeCrewDirectory` (personas + demo crew) |

Rules that apply to every port:

1. Every outbound message and call carries `idempotencyKey`. Adapters treat a repeated key as a
   no-op and return the original result. Build keys with `idempotencyKey(planId, action, ...parts)`.
2. Every inbound handler tolerates duplicate events.
3. Inbound payloads (Spectrum events, webhooks, LLM output) are validated with zod at the boundary.
4. Adapters resolve provider handles to internal `userId`s before calling the engine.

### Crews over DMs (decided by P2 in Phase 1)

Photon cannot join iMessage group chats. Every person texts their own bubble number, and the
adapter fans group messages out to each member's DM. Consequences, all inside the existing
port shapes:

1. A `Group` is a crew. `Group.chatId` is virtual: `crew:<groupId>` (`crewChatId()`,
   `groupIdFromChatId()`). `Group.status` is `pending` until every `GroupMember.confirmedAt` is
   set, then `active`.
2. `sendGroupText`, `sendPoll`, `sendRichLink`, `upsertLiveCard` on a crew chatId fan out to each
   member with a per-member idempotency key derived from the caller's. `renameGroup` and
   `setBackground` are no-ops. `closePoll` sends a "Voting closed" message.
3. Inbound plan-related DMs arrive through `onGroupMessage` with the member's crew chatId; other
   DMs go to `onPrivateMessage`. Votes arrive as per-voter state in `PollVote.choices`.
4. The message budget (`PLAN_MESSAGE_BUDGET`, 8) is per member per plan
   (`PlanMember.messagesUsed`); `PlanStore.spendMessage(planId, userId)` enforces it.
5. The adapter may only text people who have texted their bubble first (`User.onboardedAt`).

### CrewDirectory (P1)

`userByHandle`, `userById`, `createUser` (idempotent by handle), `updateUser`, `crewsOf`,
`crewById`, `crewByChatId`, `membersOf`, `createCrew` (pending; creator pre-confirmed),
`confirmMember` (active once all confirmed), `addMember`, `removeMember`. P2's signup route
calls `createUser` after Photon registration; P3's onboarding calls `createCrew` and
`confirmMember`.

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

Stable ids used by every fake, the seed script, and the demo reset: `group_demo` / `crew:group_demo`,
`user_ava` (vegetarian, $25), `user_ben` (peanut allergy, $40), `user_chloe` (halal, $20),
`user_dev` (no limits, $50, favorite `venue_demo`), `user_eli` (wheelchair, $30).

## Polls (packages/shared/src/polls.ts)

`isPollDecided(counts, remainingVoters)` returns `{ decided, leader, margin }`: decided when the
leader's margin over the runner-up exceeds the votes still out (or nobody is left and the top is
not tied). `tallyChoices(choicesByVoter, optionKeys)` turns per-voter choices into counts. The
engine uses both for early close; P2 may use them for the "Voting closed" message.

## Server internals (P1, apps/server/src)

Not contracts, but the pieces other roles call from inside the server process:

| Module                      | What it gives you                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `runtime.ts` createRuntime  | db, `bus` (SqliteEventBus), `timers`, `plans` (PlanStore), `candidates` (CandidateIndex)     |
| `engine/state-machine.ts`   | `canTransition(to, ctx)`, transition table, `IllegalTransitionError`, `isTerminal`           |
| `engine/plan-store.ts`      | `create`, `transition` (persists + audits + publishes `plan_state_changed`), members, budget |
| `events/bus.ts`             | `publish`, `subscribe`, `replay`, `replayForToken` (null when unknown or expired)            |
| `timers/service.ts`         | `schedule({ planId, kind, payload, delayMs? })`, `on(kind, handler)`, `cancel`, `pending`    |
| `venues/candidates.ts`      | `forGroup({ groupId, date, startMinutes, memberIds })`, `invalidate(groupId)`                |
| `venues/compat.ts`          | `isCompatible(venue, facts)` for diet, allergy, religious_diet, accessibility                |
| `db/seed.ts`                | idempotent seed of personas, demo group (center: Fetzer Gym), data/venues.json               |
| `engine/plan-engine.ts`     | `BubbleworksEngine implements PlanEngine`; `setIntake(P2 PlanIntake)`, `kick(planId)`        |
| `engine/intent.ts`          | `parseIntent(text)` (meal, date, time, cuisine), `parseCommand(text)`                        |
| `engine/question-policy.ts` | `decideCuisineQuestion`, `decideStartTime`, `zonedInstant`                                   |
| `solver/`                   | `solve({ venues, members, ctx, vetoedVenueIds })`: filter, score, elimination rounds         |
| `dev/routes.ts`             | `/api/dev/plans` (create, step, inspect) behind `DEV_ROUTES_SECRET`                          |

Timer kinds: `poll_deadline`, `ask_timeout`, `veto_window`, `call_timeout` use `DEADLINES` (or
`DEMO_DEADLINES` when DEMO_MODE); `day_of`, `page_token_expiry`, `custom` take `delayMs`.
Timers live in SQLite and fire after a restart.

Venue conventions: `dietTags` may include `<allergen>_free`; `accessibilityTags` is
`wheelchair` / `step_free` / `no_wheelchair` (absent means unknown and passes). The demo venue
is `venue_demo`; its phone comes from `DEMO_VENUE_PHONE`, never from the repo.

P3: `runtime.setHardFacts(fn)` points the candidate precompute at `BubbleService.getHardLimits`
(wired in `index.ts`).

Deadlock breaker (`engine/deadlock.ts`, `engine/wording.ts`): when the solver finds no feasible
venue, `analyzeDeadlock` computes, per member, the smallest budget (+5/+10/+15) or distance
(+10/+20 min) stretch that would make a venue feasible for the whole table, costs it by steps
times (1 + recent compromises), and `pickAsks` takes the two cheapest for two different people.
Each ask is a row in `asks`, a `private_ask_sent` event (id only), and one `sendPrivateText`
worded by Haiku (template fallback; drafts naming anyone else are rejected). A yes/no DM from
that person reaches `handleAskAnswer`; the first yes is recorded on the ledger as `compromised`,
cancels the other ask with a thank-you, and reruns the solver with the accepted slack. Declines
or the `ask_timeout` fall back to a time shift (30/60 min either way) or a takeout close.
Allergy, religious diet, accessibility, and diet are never relaxed.

Question bundle (P1 decides, P2 renders): `BundleRequest` carries `stylePoll` (keys `sit_down`,
`fast_food`; asked only when the feasible venues span both and the message named no style), then
`cuisinePoll`, then the headcount and page link. P2 sends polls in order; the engine calls
`closePoll` on each as soon as `isPollDecided`, and deliberation waits for both. The decided
style filters the solver (`Venue.style`, from OSM `fast_food`/`cafe` vs `restaurant`).

Diet values the solver understands (hard facts): vegetarian, vegan, pescatarian, gluten_free,
dairy_free, and the meat exclusions `no_pork`, `no_beef`, `no_red_meat`, which fail hot dog,
burger, barbecue, steakhouse and similar kitchens by their raw OSM `cuisineTags` even when a
vegetarian option exists. Deadlock asks never propose a distance stretch for a member whose
live location is unknown.

Edge cases (Phase 4, all in the engine): a headcount change in DELIBERATING / DEADLOCK / LOCKED
reruns the solver; in BOOKED / DAY_OF it calls `CallerPort.modify` and re-runs the splitter
(cancel + close when fewer than two remain); a late joiner the bubble has not met triggers
`BubbleService.onNewMember`. An organizer's "actually tomorrow" / "make it 8 instead" cancels
any booking and restarts; a different meal or day on the same chat is a second plan scoped by
its own id. A `needs_human` call result (deposit) opens a private yes/no ask to the organizer:
yes books under them, no removes the venue and reruns. On boot, `kick` reschedules the call
timeout for a plan that was mid-call, so a crashed server resumes.

Engine flow: `handleIntent` -> DETECTED -> question policy -> bundle (P2 `renderBundle`) ->
GATHERING -> headcount and votes (`isPollDecided` early close, else `poll_deadline`) ->
silent members represented (Focus, sleep, driving, with confirmed hard facts) or dropped ->
DELIBERATING -> solver rounds (`candidate_added`, `round_complete`, `candidate_eliminated`,
`bubble_merged`) -> LOCKED (`plan_locked`, group text with the veto window) -> `veto_window` ->
BOOKING (`CallerPort.book`, `doer_status`) -> `handleCallResult` -> BOOKED (`booking_confirmed`,
inviter, splitter, watcher) | declined/no answer -> rerun with the venue removed. No feasible
venue -> DEADLOCK -> breaker (above). Commands: wait, resume, cancel, veto, why.

## Invariants every module keeps

1. No bubble reveals another person's constraint anywhere.
2. Aggregates only across three or more people.
3. Allergies, religious diets, accessibility needs are never relaxed (`NEVER_RELAX_FACT_TYPES`).
4. Nothing booked, paid, or deposited without a human tap or an expired veto window.
5. Every call opens with an AI disclosure.
6. "wait" pauses; "forget that" / "forget me" delete.
7. Focus state sets quiet hours.
8. Each plan has a message budget (`PLAN_MESSAGE_BUDGET`).
