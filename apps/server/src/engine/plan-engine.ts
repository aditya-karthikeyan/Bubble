/**
 * BubbleworksEngine: the PlanEngine port. Deterministic code makes every decision; messaging,
 * bubbles, caller, and doers are ports. Every state change goes through PlanStore (persisted,
 * audited, published), every wait is a durable timer, every outbound message carries an
 * idempotency key whose prefix is the plan id so the adapter can spend the member's budget.
 *
 *   intent -> DETECTED -> bundle (poll + headcount + link) -> GATHERING
 *   headcount + votes (or the poll deadline) -> DELIBERATING -> solver rounds
 *   winner -> LOCKED -> veto window -> BOOKING -> call result -> BOOKED -> doers
 *   no feasible venue -> DEADLOCK (Phase 3 breaker takes it from there)
 */
import {
  type GeoPoint,
  MIN_AGGREGATE_GROUP_SIZE,
  MIN_PARTY_SIZE,
  SOLVER,
  idempotencyKey,
  isPollDecided,
  newId,
  tallyChoices,
  type AskAnswerInput,
  type BookingSummary,
  type BubbleService,
  type CallResult,
  type CallerPort,
  type CommandInput,
  type DoerPorts,
  type Fact,
  type HeadcountInput,
  type IntentInput,
  type IntentResult,
  type MealKind,
  type MemberChangeInput,
  type MessagingPort,
  type PageVenue,
  type Plan,
  type PlanEngine,
  type PlanMember,
  type PollOption,
  type Venue,
  type VenueStyle,
  type VoteInput,
} from '@bubbleworks/shared';
import { and, eq } from 'drizzle-orm';
import { asks, bookings, events, ledger, votes } from '../db/schema.js';
import { groupById } from '../db/seed.js';
import { silentLogger, type Logger } from '../events/bus.js';
import type { Runtime } from '../runtime.js';
import { headcountText } from '../messaging/bundle.js';
import { filterCandidates } from '../solver/filter.js';
import { solve } from '../solver/rounds.js';
import type { SolverContext, SolverMember } from '../solver/types.js';
import { distanceM, walkMinutes } from '../venues/geo.js';
import { dayOfWeek } from '../venues/hours.js';
import { HACKATHON_CENTER } from '../venues/demo-venue.js';
import type { VenueSource } from '../venues/places.js';
import { MAX_DISTANCE_SLACK_MIN, analyzeDeadlock, pickAsks } from './deadlock.js';
import { parseIntent } from './intent.js';
import {
  cuisineSwitchAsk,
  cuisineSwitchNotice,
  styleOverrideText,
  noFitText,
  TemplateAskWriter,
  thankYouText,
  type AskWriter,
} from './wording.js';
import {
  cuisineLabel,
  cuisineOptions,
  decideCuisineQuestion,
  decideStartTime,
  decideStyleQuestion,
  earliestStart,
  zonedInstant,
} from './question-policy.js';
import { IllegalTransitionError, isTerminal } from './state-machine.js';
import type { FiredTimer } from '../timers/service.js';

/** Structurally identical to P2's QuestionDecision so PlanIntake.renderBundle accepts it. */
/** Agent-first reach, in walking minutes (about 5 km): dinner is a drive, not a stroll. */
const AGENT_FIRST_REACH_MIN = 60;

export interface BundleRequest {
  planId: string;
  chatId: string;
  organizerName: string;
  meal: MealKind | null;
  dayOffset?: 0 | 1;
  /** Asked first when the feasible venues span sit-down and fast food. P2 sends polls in order. */
  stylePoll: { pollId: string; question?: string; options: PollOption[] } | null;
  cuisinePoll: { pollId: string; question?: string; options: PollOption[] } | null;
  headcount: { closesAt: string; timezone: string; mode?: 'opt_in' | 'opt_out' };
  /** Cuisine named in the message, for the headcount line. */
  cuisine?: string | null;
  pageUrl: string | null;
}

export interface BundleRenderer {
  renderBundle(decision: BundleRequest): Promise<unknown>;
  closePlan(planId: string): void;
  /** Rewrite a poll that has not gone out yet; null drops it. */
  updatePoll?(planId: string, pollId: string, options: PollOption[] | null): boolean;
}

export interface EngineDeps {
  runtime: Runtime;
  bubbles: BubbleService;
  messaging: MessagingPort;
  caller: CallerPort;
  doers: DoerPorts;
  /** P2's PlanIntake. Without it the engine renders a plain bundle through MessagingPort. */
  intake?: BundleRenderer | null;
  /** Writes the private concession asks. Defaults to the template writer. */
  askWriter?: AskWriter;
  webPublicUrl?: string | null;
  timezone?: string;
  log?: Logger;
  now?: () => Date;
  /**
   * Clock used only to decide start times (DEMO_PLAN_CLOCK): a demo at 11 PM still plans dinner
   * as if it were early evening. Deadlines, timers, and events keep the real clock.
   */
  planningNow?: () => Date;
  /** See config FLOW. agent_first: no polls, opt-out headcount, sit-down within a drive. */
  flow?: 'polls' | 'agent_first';
  /** Live restaurants, searched when a plan starts. Absent: the stored venues. */
  venueSource?: VenueSource | null;
  /** Demo rehearsals: every booking call rings this number instead of the venue. */
  callRedirectPhone?: string | null;
}

interface PollSpec {
  pollId: string;
  options: PollOption[];
}

/** The polls a plan asked: style first, then cuisine. Persisted in the poll_deadline payload. */
interface PlanPolls {
  style: PollSpec | null;
  cuisine: PollSpec | null;
}

export class BubbleworksEngine implements PlanEngine {
  private readonly rt: Runtime;
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly tz: string;
  private readonly polls = new Map<string, PlanPolls>();
  private readonly closedPolls = new Set<string>();
  private readonly vetoed = new Map<string, Set<string>>();
  /** Plans whose unreachable cuisine was dropped without anyone to ask. */
  private readonly cuisineDropped = new Set<string>();
  /** Plans whose style vote fit nobody at the table, moved to the other style (with a heads-up). */
  private readonly styleOverride = new Map<string, VenueStyle>();
  private readonly t0 = new Map<string, number>();

  private planNow(): Date {
    return this.deps.planningNow?.() ?? this.now();
  }

  /** P2's PlanIntake is created from the engine, so it attaches after construction. */
  setIntake(intake: BundleRenderer | null): void {
    this.deps.intake = intake;
  }

  constructor(private readonly deps: EngineDeps) {
    this.rt = deps.runtime;
    this.log = deps.log ?? deps.runtime.log ?? silentLogger;
    this.now = deps.now ?? (() => new Date());
    this.tz = deps.timezone ?? 'America/New_York';
    this.rt.timers.on('poll_deadline', (t) => this.onPollDeadline(t));
    this.rt.timers.on('veto_window', (t) => this.onVetoWindow(t));
    this.rt.timers.on('call_timeout', (t) => this.onCallTimeout(t));
    this.rt.timers.on('ask_timeout', (t) => this.onAskTimeout(t));
    this.askWriter = deps.askWriter ?? new TemplateAskWriter();
  }

  private readonly askWriter: AskWriter;

  // -- PlanEngine ----------------------------------------------------------------

  async handleIntent(input: IntentInput): Promise<IntentResult> {
    const crew = await this.rt.crews.crewByChatId(input.chatId);
    if (!crew) return { planId: null, created: false };
    const intent = parseIntent(input.text, { now: this.now(), timezone: this.tz });
    const changeWords = /\b(actually|instead|change|switch|make it|move it|rather)\b/i.test(
      input.text,
    );
    const actives = this.rt.plans.findActiveForChat(input.chatId);
    const same = actives.find(
      (p) => p.intent.date === intent.date && p.intent.meal === intent.meal,
    );
    const differentTime = (p: Plan) =>
      intent.startMinutes !== null && intent.startMinutes !== p.intent.startMinutes;
    // "actually tomorrow" / "make it 8 instead" from the organizer restarts their open plan.
    const changed = actives.find(
      (p) =>
        p.createdByUserId === input.userId &&
        changeWords &&
        (p.intent.date !== intent.date || differentTime(p)),
    );
    if (changed) {
      await this.restart(changed.id, `plan changed: ${input.text.slice(0, 60)}`);
    } else if (same) {
      // Same meal, same day, no change asked: a repeat joins the open plan. A different meal or
      // day on the same chat becomes a second plan, scoped by its own id, poll, and messages.
      this.log.info({ planId: same.id, state: same.state }, 'intent ignored: plan already open');
      return { planId: same.id, created: false };
    }
    const started = Date.now();
    const organizer = await this.rt.crews.userById(input.userId);
    const plan = this.rt.plans.create({
      groupId: crew.id,
      chatId: crew.chatId,
      intent,
      createdByUserId: input.userId,
      sourceMessageId: input.messageId,
      demoMode: this.rt.timers.deadlines.poll_ms <= 60_000,
    });
    this.t0.set(plan.id, started);
    this.mark(plan.id, 't_detect', started);
    await this.rt.plans.transition(plan.id, 'DETECTED', {
      reason: `intent: ${intent.meal} ${intent.date}`,
    });

    const memberUsers = await this.rt.crews.membersOf(crew.id);
    for (const u of memberUsers) {
      this.rt.plans.upsertMember(plan.id, u.id, u.id === input.userId ? 'in' : 'invited');
    }
    await this.publish(plan.id, {
      type: 'bubble_joined',
      bubble: {
        userId: input.userId,
        displayName: organizer?.displayName ?? 'Organizer',
        status: 'fits',
      },
    });

    await this.refreshVenues(plan);
    // Preview with everyone in the crew so the question policy sees the whole table.
    const members = await this.solverMembers(
      plan,
      memberUsers.map((u) => u.id),
      new Set(),
    );
    const busy: Record<string, (typeof members)[number]['busy']> = {};
    for (const m of members) busy[m.userId] = m.busy;
    const time = decideStartTime(intent.startMinutes, busy, intent.date, this.tz, this.planNow());
    const ctx = this.ctx(plan, time.startMinutes);
    const preview = solve({ venues: this.rt.venues(), members, ctx });
    const style = decideStyleQuestion(preview.feasible, intent.style ?? null);
    const cuisine = decideCuisineQuestion(preview.feasible, members, ctx, intent.cuisine);
    this.log.info(
      {
        planId: plan.id,
        feasible: preview.feasible.length,
        askStyle: style.ask,
        styleReason: style.reason,
        askCuisine: cuisine.ask,
        reason: cuisine.reason,
        startMinutes: time.startMinutes,
        timeTie: time.tie,
        timeBumped: time.bumped,
        freeCounts: time.freeCounts,
      },
      'question policy',
    );
    if (time.startMinutes !== intent.startMinutes || time.bumped) {
      this.rt.plans.setChoice(plan.id, {
        chosenVenueId: null,
        backupVenueId: null,
        startAt: this.startAtIso(intent.date, time.startMinutes),
      });
    }

    const agentFirst = this.agentFirst();
    const polls: PlanPolls = {
      style: style.ask && !agentFirst ? { pollId: newId('poll'), options: style.options } : null,
      // With a style question, cuisine always follows it (unless named); its options are
      // provisional and get rebuilt for the people who are in once the style is decided.
      cuisine:
        !agentFirst && (cuisine.ask || (style.ask && !intent.cuisine))
          ? {
              pollId: newId('poll'),
              options: cuisine.ask
                ? cuisine.options
                : cuisineOptions(preview.feasible, members, ctx),
            }
          : null,
    };
    this.polls.set(plan.id, polls);
    const closesAt = new Date(
      this.now().getTime() + this.rt.timers.deadlines.poll_ms,
    ).toISOString();
    const request: BundleRequest = {
      planId: plan.id,
      chatId: crew.chatId,
      organizerName: organizer?.displayName ?? 'Someone',
      meal: intent.meal,
      dayOffset:
        intent.date === parseIntent('', { now: this.now(), timezone: this.tz }).date ? 0 : 1,
      stylePoll: polls.style ? { pollId: polls.style.pollId, options: polls.style.options } : null,
      cuisinePoll: polls.cuisine
        ? { pollId: polls.cuisine.pollId, options: polls.cuisine.options }
        : null,
      headcount: {
        closesAt,
        timezone: this.tz,
        ...(agentFirst ? { mode: 'opt_out' as const } : {}),
      },
      cuisine: intent.cuisine ?? null,
      pageUrl: this.pageUrl(plan),
    };
    if (this.deps.intake) await this.deps.intake.renderBundle(request);
    else await this.renderPlainBundle(request);
    this.mark(plan.id, 't_poll_posted');

    await this.rt.plans.transition(plan.id, 'GATHERING', { reason: 'bundle posted' });
    this.rt.timers.schedule({
      planId: plan.id,
      kind: 'poll_deadline',
      payload: {
        ...(polls.cuisine ? { pollId: polls.cuisine.pollId, options: polls.cuisine.options } : {}),
        ...(polls.style
          ? { stylePollId: polls.style.pollId, styleOptions: polls.style.options }
          : {}),
      },
    });
    return { planId: plan.id, created: true };
  }

  async handleHeadcount(input: HeadcountInput): Promise<void> {
    const plan = this.rt.plans.get(input.planId);
    if (!plan || isTerminal(plan.state) || plan.state === 'PAUSED') return;
    const before = this.rt.plans.members(plan.id).find((m) => m.userId === input.userId);
    const status = input.in ? 'in' : 'out';
    if (before?.status === status) return;
    const wasIn = before?.status === 'in' || before?.status === 'represented';
    this.rt.plans.upsertMember(plan.id, input.userId, status);
    const user = await this.rt.crews.userById(input.userId);
    if (input.in) {
      await this.publish(plan.id, {
        type: 'bubble_joined',
        bubble: {
          userId: input.userId,
          displayName: user?.displayName ?? input.userId,
          status: 'fits',
        },
      });
      if (before === undefined || before.status === 'dropped') {
        // A late joiner the bubble has not met: let P3 catch them up.
        await this.deps.bubbles.onNewMember({
          groupId: plan.groupId,
          chatId: plan.chatId,
          userId: input.userId,
        });
      }
    } else {
      await this.publish(plan.id, { type: 'bubble_left', userId: input.userId, reason: 'out' });
    }
    this.rt.candidates.invalidate(plan.groupId);

    switch (plan.state) {
      case 'GATHERING':
        await this.maybeAdvance(plan.id);
        return;
      case 'DELIBERATING':
      case 'DEADLOCK':
      case 'LOCKED':
        // Before booking the table changed, so the answer may change: rerun.
        if (input.in || wasIn)
          await this.rerun(plan.id, input.in ? 'late joiner' : 'dropout before booking');
        return;
      case 'BOOKING':
        // Mid-call: note it; the next booked result reflects the table at lock time and a
        // follow-up headcount after BOOKED modifies the reservation.
        this.rt.plans.audit(plan.id, 'headcount_during_call', { userId: input.userId, status });
        return;
      case 'BOOKED':
      case 'DAY_OF':
        if (input.in || wasIn)
          await this.modifyBooking(
            plan.id,
            input.in ? 'late joiner after booking' : 'dropout after booking',
          );
        return;
      default:
        return;
    }
  }

  async handleVote(input: VoteInput): Promise<void> {
    const plan = this.rt.plans.get(input.planId);
    if (!plan || plan.state !== 'GATHERING') return;
    const polls = this.pollSpec(plan.id);
    const kind: 'style' | 'cuisine' | null =
      polls?.style?.pollId === input.pollId
        ? 'style'
        : polls?.cuisine?.pollId === input.pollId
          ? 'cuisine'
          : null;
    const spec = kind === 'style' ? polls?.style : kind === 'cuisine' ? polls?.cuisine : null;
    if (!kind || !spec) return;
    const at = input.at;
    // Voting on where to eat is saying you are coming: an undecided member who votes is in.
    const member = this.rt.plans.members(plan.id).find((m) => m.userId === input.userId);
    if (input.choices.length > 0 && (!member || member.status === 'invited')) {
      await this.handleHeadcount({ planId: plan.id, userId: input.userId, in: true, at });
      if (this.rt.plans.get(plan.id)?.state !== 'GATHERING') return;
    }
    this.rt.db.transaction((tx) => {
      tx.delete(votes)
        .where(and(eq(votes.pollId, input.pollId), eq(votes.userId, input.userId)))
        .run();
      for (const choice of new Set(input.choices)) {
        if (!spec.options.some((o) => o.key === choice)) continue;
        tx.insert(votes)
          .values({
            id: newId('vote'),
            planId: plan.id,
            pollId: input.pollId,
            kind,
            userId: input.userId,
            choice,
            at,
          })
          .run();
      }
    });
    const { decision } = this.tally(plan.id, spec);
    if (decision.decided && !this.closedPolls.has(spec.pollId)) {
      await this.closePoll(plan, spec, decision.leader);
    }
    await this.maybeAdvance(plan.id);
  }

  /** The pending concession ask addressed to this person, if any (for DM routing). */
  pendingAskFor(userId: string): { askId: string; planId: string } | null {
    const row = this.rt.db
      .select({ id: asks.id, planId: asks.planId })
      .from(asks)
      .where(and(eq(asks.userId, userId), eq(asks.status, 'pending')))
      .get();
    return row ? { askId: row.id, planId: row.planId } : null;
  }

  async handleAskAnswer(input: AskAnswerInput): Promise<void> {
    const ask = this.rt.db.select().from(asks).where(eq(asks.id, input.askId)).get();
    if (!ask || ask.status !== 'pending' || ask.userId !== input.userId) return;
    const plan = this.rt.plans.get(ask.planId);
    if (!plan) return;
    const at = this.now().toISOString();
    if (ask.kind === 'deposit') {
      await this.answerDeposit(plan, ask.id, input.answer, at);
      return;
    }
    if (ask.kind === 'cuisine') {
      await this.answerCuisineSwitch(plan, ask.id, ask.userId, input.answer, at);
      return;
    }
    if (input.answer === 'no') {
      this.rt.db
        .update(asks)
        .set({ status: 'declined', resolvedAt: at })
        .where(eq(asks.id, ask.id))
        .run();
      await this.publish(plan.id, {
        type: 'private_ask_resolved',
        askId: ask.id,
        outcome: 'declined',
      });
      await this.deps.messaging.sendPrivateText({
        userId: ask.userId,
        text: 'No problem, thanks for the quick answer.',
        idempotencyKey: idempotencyKey(plan.id, 'ask_declined', ask.id),
      });
      await this.afterAsksResolved(plan.id);
      return;
    }
    // First yes wins.
    this.rt.db
      .update(asks)
      .set({ status: 'accepted', resolvedAt: at })
      .where(eq(asks.id, ask.id))
      .run();
    await this.publish(plan.id, {
      type: 'private_ask_resolved',
      askId: ask.id,
      outcome: 'accepted',
    });
    if (ask.concession) {
      this.rt.db
        .insert(ledger)
        .values({
          id: newId('ledger'),
          groupId: plan.groupId,
          planId: plan.id,
          userId: ask.userId,
          kind: 'compromised',
          amount: ask.concession.cost,
          note: `${ask.kind} ${ask.concession.from} -> ${ask.concession.to}`,
          at,
        })
        .run();
    }
    const others = this.rt.db
      .select()
      .from(asks)
      .where(and(eq(asks.planId, plan.id), eq(asks.status, 'pending')))
      .all();
    for (const other of others) {
      this.rt.db
        .update(asks)
        .set({ status: 'cancelled', resolvedAt: at })
        .where(eq(asks.id, other.id))
        .run();
      await this.publish(plan.id, {
        type: 'private_ask_resolved',
        askId: other.id,
        outcome: 'cancelled',
      });
      const user = await this.rt.crews.userById(other.userId);
      await this.deps.messaging.sendPrivateText({
        userId: other.userId,
        text: thankYouText(user?.displayName ?? 'there'),
        idempotencyKey: idempotencyKey(plan.id, 'ask_thanks', other.id),
      });
    }
    this.rt.timers.cancel(plan.id, 'ask_timeout');
    await this.deps.messaging.sendPrivateText({
      userId: ask.userId,
      text: 'Thank you! Locking it in.',
      idempotencyKey: idempotencyKey(plan.id, 'ask_accepted', ask.id),
    });
    if (plan.state === 'DEADLOCK') await this.deliberate(plan.id);
  }

  async handleMemberChange(input: MemberChangeInput): Promise<void> {
    this.rt.candidates.invalidate();
    const plan = this.rt.plans.findActiveForChat(input.chatId)[0];
    if (!plan) return;
    if (input.change === 'joined') {
      if (!['GATHERING', 'DELIBERATING', 'DEADLOCK'].includes(plan.state)) return;
      this.rt.plans.upsertMember(plan.id, input.userId, 'invited');
      await this.deps.bubbles.onNewMember({
        groupId: plan.groupId,
        chatId: plan.chatId,
        userId: input.userId,
      });
      return;
    }
    const member = this.rt.plans.members(plan.id).find((m) => m.userId === input.userId);
    if (!member || member.status === 'dropped') return;
    this.rt.plans.upsertMember(plan.id, input.userId, 'dropped');
    await this.publish(plan.id, {
      type: 'bubble_left',
      userId: input.userId,
      reason: 'left_group',
    });
    if (
      ['DELIBERATING', 'DEADLOCK', 'LOCKED'].includes(plan.state) &&
      (member.status === 'in' || member.status === 'represented')
    ) {
      await this.rerun(plan.id, 'member left');
    }
  }

  async handleCallResult(result: CallResult): Promise<void> {
    const plan = this.rt.plans.get(result.planId);
    if (!plan) return;
    const booking = this.rt.db
      .select()
      .from(bookings)
      .where(eq(bookings.id, result.bookingId))
      .get();
    if (!booking) {
      this.log.warn(
        { planId: plan.id, bookingId: result.bookingId },
        'call result for unknown booking',
      );
      return;
    }
    if (
      booking.callId === result.callId &&
      ['booked', 'failed', 'needs_human', 'cancelled'].includes(booking.status)
    )
      return; // duplicate
    this.rt.timers.cancel(plan.id, 'call_timeout');
    const at = this.now().toISOString();

    switch (result.outcome) {
      case 'booked':
      case 'booked_backup': {
        if (plan.state !== 'BOOKING') return;
        const venueId = result.venueId ?? booking.venueId;
        const venue = this.rt.venues().find((v) => v.id === venueId);
        if (!venue) throw new Error(`booked at unknown venue ${venueId}`);
        const startAt = result.confirmedStartAt ?? booking.startAt;
        this.rt.db
          .update(bookings)
          .set({
            status: 'booked',
            venueId,
            callId: result.callId,
            confirmationCode: result.confirmationCode,
            startAt,
            updatedAt: at,
          })
          .where(eq(bookings.id, booking.id))
          .run();
        if (result.outcome === 'booked_backup') {
          this.rt.plans.setChoice(plan.id, {
            chosenVenueId: venueId,
            backupVenueId: null,
            startAt,
          });
        }
        await this.rt.plans.transition(plan.id, 'BOOKED', {
          reason: `call result: ${result.outcome}`,
        });
        this.mark(plan.id, 't_booked');
        await this.publish(plan.id, {
          type: 'doer_status',
          doer: 'caller',
          state: 'done',
          detail: result.outcome === 'booked_backup' ? 'Booked the backup' : 'Booked',
        });
        const members = this.rt.plans.members(plan.id);
        const partySize = members.filter(
          (m) => m.status === 'in' || m.status === 'represented',
        ).length;
        await this.publish(plan.id, {
          type: 'booking_confirmed',
          bookingId: booking.id,
          venue: pageVenue(venue),
          startAt,
          partySize,
          reservationName: booking.reservationName,
        });
        await this.groupText(plan, 'booked', `Booked: ${result.summary}`);
        await this.fireDoers(plan, {
          bookingId: booking.id,
          planId: plan.id,
          chatId: plan.chatId,
          venue,
          startAt,
          partySize,
          reservationName: booking.reservationName,
          confirmationCode: result.confirmationCode,
          members,
        });
        return;
      }
      case 'needs_human': {
        this.rt.db
          .update(bookings)
          .set({
            status: 'needs_human',
            callId: result.callId,
            depositRequested: result.depositRequested,
            updatedAt: at,
          })
          .where(eq(bookings.id, booking.id))
          .run();
        await this.publish(plan.id, {
          type: 'doer_status',
          doer: 'caller',
          state: 'needs_human',
          detail: result.depositRequested
            ? 'The restaurant wants a deposit'
            : 'The restaurant needs a person',
        });
        // One person decides; nothing is secured until they say yes.
        const askId = newId('ask');
        const key = idempotencyKey(plan.id, 'deposit_ask', booking.id);
        const text = `${result.summary} Reply "yes" to go ahead or "no" to pick somewhere else.`;
        this.rt.db
          .insert(asks)
          .values({
            id: askId,
            planId: plan.id,
            userId: plan.createdByUserId,
            kind: 'deposit',
            concession: null,
            text,
            status: 'pending',
            idempotencyKey: key,
            sentAt: at,
            expiresAt: new Date(
              this.now().getTime() + this.rt.timers.deadlines.private_ask_ms,
            ).toISOString(),
          })
          .onConflictDoNothing()
          .run();
        await this.publish(plan.id, { type: 'private_ask_sent', askId });
        await this.deps.messaging.sendPrivateText({
          userId: plan.createdByUserId,
          text,
          idempotencyKey: key,
        });
        return;
      }
      case 'declined':
      case 'no_answer': {
        if (plan.state !== 'BOOKING') return;
        this.rt.db
          .update(bookings)
          .set({ status: 'failed', callId: result.callId, notes: result.outcome, updatedAt: at })
          .where(eq(bookings.id, booking.id))
          .run();
        await this.publish(plan.id, {
          type: 'doer_status',
          doer: 'caller',
          state: 'failed',
          detail:
            result.outcome === 'declined'
              ? 'No table, trying the next place'
              : 'No answer, trying the next place',
        });
        this.addVetoed(plan.id, booking.venueId);
        if (booking.backupVenueId) this.addVetoed(plan.id, booking.backupVenueId);
        await this.rt.plans.transition(plan.id, 'DELIBERATING', {
          reason: `call ${result.outcome}`,
        });
        await this.deliberate(plan.id);
        return;
      }
      case 'failed': {
        // One venue we could not call (bad number, refused, provider error) is not the end of
        // the plan: drop it and let the solver try the next place. Only the deadlock path can
        // close a plan for lack of venues.
        if (plan.state !== 'BOOKING') return;
        this.rt.db
          .update(bookings)
          .set({ status: 'failed', callId: result.callId, notes: 'failed', updatedAt: at })
          .where(eq(bookings.id, booking.id))
          .run();
        await this.publish(plan.id, {
          type: 'doer_status',
          doer: 'caller',
          state: 'failed',
          detail: 'Could not reach them, trying the next place',
        });
        this.addVetoed(plan.id, booking.venueId);
        await this.rt.plans.transition(plan.id, 'DELIBERATING', { reason: 'call failed' });
        await this.deliberate(plan.id);
        return;
      }
      case 'modified': {
        const party = this.rt.plans
          .members(plan.id)
          .filter((m) => m.status === 'in' || m.status === 'represented');
        this.rt.db
          .update(bookings)
          .set({
            status: 'booked',
            partySize: party.length,
            callId: result.callId,
            startAt: result.confirmedStartAt ?? booking.startAt,
            updatedAt: at,
          })
          .where(eq(bookings.id, booking.id))
          .run();
        await this.publish(plan.id, {
          type: 'doer_status',
          doer: 'caller',
          state: 'done',
          detail: `Updated to ${party.length}`,
        });
        await this.groupText(
          plan,
          `modified:${party.length}`,
          `Updated the table to ${party.length}. ${result.summary}`.trim(),
        );
        const venue = this.rt.venues().find((v) => v.id === booking.venueId);
        if (venue) {
          await this.publish(plan.id, { type: 'doer_status', doer: 'splitter', state: 'started' });
          const r = await this.deps.doers.splitter.send({
            bookingId: booking.id,
            planId: plan.id,
            chatId: plan.chatId,
            venue,
            startAt: booking.startAt,
            partySize: party.length,
            reservationName: booking.reservationName,
            confirmationCode: booking.confirmationCode,
            members: this.rt.plans.members(plan.id),
            idempotencyKey: idempotencyKey(plan.id, 'splitter', booking.id, party.length),
          });
          await this.publish(plan.id, {
            type: 'doer_status',
            doer: 'splitter',
            state: r.ok ? 'done' : 'failed',
          });
        }
        return;
      }
      case 'cancelled': {
        this.rt.db
          .update(bookings)
          .set({ status: 'cancelled', callId: result.callId, updatedAt: at })
          .where(eq(bookings.id, booking.id))
          .run();
        await this.publish(plan.id, {
          type: 'doer_status',
          doer: 'caller',
          state: 'done',
          detail: 'Reservation cancelled',
        });
        return;
      }
      default:
        this.log.info({ planId: plan.id, outcome: result.outcome }, 'call result noted');
    }
  }

  /** A seat count change after booking: keep the venue, ask the caller to modify, redo the split. */
  private async modifyBooking(planId: string, reason: string): Promise<void> {
    const plan = this.rt.plans.mustGet(planId);
    const booking = this.rt.db
      .select()
      .from(bookings)
      .where(and(eq(bookings.planId, planId), eq(bookings.status, 'booked')))
      .get();
    const venue = booking ? this.rt.venues().find((v) => v.id === booking.venueId) : null;
    if (!booking || !venue) return;
    const party = this.rt.plans
      .members(planId)
      .filter((m) => m.status === 'in' || m.status === 'represented');
    if (party.length < MIN_PARTY_SIZE) {
      await this.deps.caller.cancel({
        planId,
        bookingId: booking.id,
        venue,
        reservationName: booking.reservationName,
        idempotencyKey: idempotencyKey(planId, 'cancel_call', booking.id),
      });
      this.rt.timers.cancel(planId);
      await this.rt.plans.transition(planId, 'CANCELLED', {
        reason: `${reason}: only ${party.length} left`,
      });
      await this.publish(planId, { type: 'plan_closed', reason: 'too_few' });
      await this.groupText(
        plan,
        'cancelled_too_few',
        'Not enough people left, so I cancelled the table.',
      );
      return;
    }
    this.rt.plans.audit(planId, 'booking_modify', { reason, partySize: party.length });
    await this.publish(planId, {
      type: 'doer_status',
      doer: 'caller',
      state: 'working',
      detail: `Updating the table to ${party.length}`,
    });
    await this.deps.caller.modify({
      planId,
      bookingId: booking.id,
      venue,
      partySize: party.length,
      startAt: booking.startAt,
      reservationName: booking.reservationName,
      idempotencyKey: idempotencyKey(planId, 'modify', booking.id, party.length),
    });
  }

  /** "Actually tomorrow": cancel anything booked and close this plan so the new intent starts fresh. */
  private async restart(planId: string, reason: string): Promise<void> {
    const plan = this.rt.plans.mustGet(planId);
    this.rt.timers.cancel(planId);
    const booking = this.rt.db
      .select()
      .from(bookings)
      .where(and(eq(bookings.planId, planId), eq(bookings.status, 'booked')))
      .get();
    const venue = booking ? this.rt.venues().find((v) => v.id === booking.venueId) : null;
    if (booking && venue) {
      await this.deps.caller.cancel({
        planId,
        bookingId: booking.id,
        venue,
        reservationName: booking.reservationName,
        idempotencyKey: idempotencyKey(planId, 'cancel_call', booking.id),
      });
      this.rt.db
        .update(bookings)
        .set({ status: 'cancelled', updatedAt: this.now().toISOString() })
        .where(eq(bookings.id, booking.id))
        .run();
    }
    await this.rt.plans.transition(planId, 'CANCELLED', { reason });
    await this.publish(planId, { type: 'plan_closed', reason: 'cancelled' });
    this.deps.intake?.closePlan(planId);
    await this.groupText(plan, 'restarted', 'Got it, starting over with the new plan.');
  }

  async handleCommand(input: CommandInput): Promise<void> {
    const plan = input.planId
      ? this.rt.plans.get(input.planId)
      : this.rt.plans.findActiveForChat(input.chatId)[0];
    if (!plan) {
      await this.deps.messaging.sendPrivateText({
        userId: input.userId,
        text: 'No plan is running right now.',
        idempotencyKey: idempotencyKey('noplan', input.command, input.messageId),
      });
      return;
    }
    switch (input.command) {
      case 'wait': {
        const r = await this.rt.plans.tryTransition(plan.id, 'PAUSED', {
          reason: `command: wait (${input.userId})`,
          actor: input.userId,
        });
        if (r.ok)
          await this.groupText(
            plan,
            'paused',
            'Paused. Say "resume" when you want me to carry on.',
          );
        return;
      }
      case 'resume': {
        if (plan.state !== 'PAUSED' || !plan.resumeState) return;
        await this.rt.plans.transition(plan.id, plan.resumeState, {
          reason: `command: resume (${input.userId})`,
          actor: input.userId,
        });
        await this.kick(plan.id);
        return;
      }
      case 'cancel': {
        this.rt.timers.cancel(plan.id);
        const booking = this.rt.db
          .select()
          .from(bookings)
          .where(and(eq(bookings.planId, plan.id), eq(bookings.status, 'booked')))
          .get();
        if (booking) {
          const venue = this.rt.venues().find((v) => v.id === booking.venueId);
          if (venue)
            await this.deps.caller.cancel({
              planId: plan.id,
              bookingId: booking.id,
              venue,
              reservationName: booking.reservationName,
              idempotencyKey: idempotencyKey(plan.id, 'cancel_call', booking.id),
            });
        }
        await this.rt.plans.transition(plan.id, 'CANCELLED', {
          reason: `command: cancel (${input.userId})`,
          actor: input.userId,
        });
        await this.publish(plan.id, { type: 'plan_closed', reason: 'cancelled' });
        this.deps.intake?.closePlan(plan.id);
        await this.groupText(plan, 'cancelled', 'Plan cancelled.');
        return;
      }
      case 'veto': {
        if (plan.state !== 'LOCKED' || !plan.chosenVenueId) {
          await this.deps.messaging.sendPrivateText({
            userId: input.userId,
            text: 'Nothing is locked right now, so there is nothing to veto.',
            idempotencyKey: idempotencyKey(plan.id, 'veto_noop', input.messageId),
          });
          return;
        }
        this.addVetoed(plan.id, plan.chosenVenueId);
        this.rt.timers.cancel(plan.id, 'veto_window');
        await this.publish(plan.id, {
          type: 'candidate_eliminated',
          venueId: plan.chosenVenueId,
          round: this.roundsSoFar(plan.id) + 1,
          reason: 'vetoed',
        });
        await this.rt.plans.transition(plan.id, 'DELIBERATING', {
          reason: `command: veto (${input.userId})`,
          actor: input.userId,
        });
        await this.deliberate(plan.id);
        return;
      }
      case 'why': {
        await this.deps.messaging.sendPrivateText({
          userId: input.userId,
          text: this.explain(plan),
          idempotencyKey: idempotencyKey(plan.id, 'why', input.messageId),
        });
        return;
      }
    }
  }

  // -- timers --------------------------------------------------------------------

  private async onPollDeadline(t: FiredTimer): Promise<void> {
    const plan = this.rt.plans.get(t.planId);
    if (!plan || plan.state !== 'GATHERING') return;
    const polls = this.pollSpec(plan.id, t.payload);
    for (const spec of [polls?.style, polls?.cuisine]) {
      if (!spec || this.closedPolls.has(spec.pollId)) continue;
      const { decision } = this.tally(plan.id, spec);
      await this.closePoll(plan, spec, decision.leader);
    }
    await this.resolveSilentMembers(plan);
    await this.deliberate(plan.id);
  }

  private async onVetoWindow(t: FiredTimer): Promise<void> {
    const plan = this.rt.plans.get(t.planId);
    if (!plan || plan.state !== 'LOCKED') return;
    await this.book(plan.id);
  }

  private async onCallTimeout(t: FiredTimer): Promise<void> {
    const plan = this.rt.plans.get(t.planId);
    if (!plan || plan.state !== 'BOOKING') return;
    const booking = this.rt.db
      .select()
      .from(bookings)
      .where(eq(bookings.planId, plan.id))
      .all()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!booking || booking.status === 'booked') return;
    await this.handleCallResult({
      planId: plan.id,
      bookingId: booking.id,
      callId: booking.callId ?? 'timeout',
      outcome: 'no_answer',
      venueId: null,
      confirmationCode: null,
      confirmedStartAt: null,
      depositRequested: false,
      summary: 'No answer in time.',
      at: this.now().toISOString(),
    });
  }

  /** After a resume (or restart) push the plan to its next step if its deadline already passed. */
  async kick(planId: string): Promise<void> {
    const plan = this.rt.plans.get(planId);
    if (!plan) return;
    const pending = this.rt.timers.pending(planId).map((t) => t.kind);
    if (plan.state === 'GATHERING' && !pending.includes('poll_deadline')) {
      await this.onPollDeadline({
        id: '',
        planId,
        kind: 'poll_deadline',
        fireAt: 0,
        payload: {},
        firedAt: '',
        lateMs: 0,
        createdAt: '',
      });
    } else if (plan.state === 'LOCKED' && !pending.includes('veto_window')) {
      this.rt.timers.schedule({ planId, kind: 'veto_window' });
    } else if (plan.state === 'DELIBERATING') {
      await this.deliberate(planId);
    } else if (plan.state === 'BOOKING' && !pending.includes('call_timeout')) {
      // Restart mid-call: the webhook may still deliver; if not, the timeout reruns the solver.
      const booking = this.rt.db
        .select()
        .from(bookings)
        .where(eq(bookings.planId, planId))
        .all()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      this.rt.timers.schedule({
        planId,
        kind: 'call_timeout',
        payload: { bookingId: booking?.id ?? '' },
        replace: true,
      });
      this.log.warn({ planId }, 'resumed mid-call: call_timeout rescheduled');
    } else if (plan.state === 'DEADLOCK' && !pending.includes('ask_timeout')) {
      await this.afterAsksResolved(planId);
    }
  }

  // -- flow ----------------------------------------------------------------------

  private async maybeAdvance(planId: string): Promise<void> {
    const plan = this.rt.plans.get(planId);
    if (!plan || plan.state !== 'GATHERING') return;
    const members = this.rt.plans.members(planId);
    const undecided = members.filter((m) => m.status === 'invited');
    if (undecided.length > 0) return;
    const inCount = members.filter((m) => m.status === 'in' || m.status === 'represented').length;
    if (inCount < MIN_PARTY_SIZE) {
      // Nobody left to wait for and not enough people: close now instead of holding the poll.
      this.rt.timers.cancel(planId, 'poll_deadline');
      await this.deliberate(planId);
      return;
    }
    const polls = this.pollSpec(planId);
    for (const spec of [polls?.style, polls?.cuisine]) {
      if (!spec || this.closedPolls.has(spec.pollId)) continue;
      const { decision, remaining } = this.tally(planId, spec);
      if (!decision.decided && remaining > 0) return;
      await this.closePoll(plan, spec, decision.leader);
    }
    this.rt.timers.cancel(planId, 'poll_deadline');
    await this.deliberate(planId);
  }

  /** Members who never answered: represent them when their bubble may, otherwise drop them. */
  private async resolveSilentMembers(plan: Plan): Promise<void> {
    for (const m of this.rt.plans.members(plan.id)) {
      if (m.status !== 'invited') continue;
      const presence = await this.deps.bubbles.getPresence(m.userId);
      const user = await this.rt.crews.userById(m.userId);
      // Opt-out headcount: silence is a yes unless the person is clearly unavailable.
      if (this.agentFirst() && !['sleep', 'driving'].includes(presence)) {
        this.rt.plans.upsertMember(plan.id, m.userId, 'in');
        await this.publish(plan.id, {
          type: 'bubble_joined',
          bubble: {
            userId: m.userId,
            displayName: user?.displayName ?? m.userId,
            status: 'fits',
          },
        });
        continue;
      }
      const hard = (await this.deps.bubbles.getHardLimits(m.userId)).filter((f) => f.confirmed);
      const canRepresent = ['focus', 'sleep', 'driving'].includes(presence) && hard.length > 0;
      if (canRepresent) {
        this.rt.plans.upsertMember(plan.id, m.userId, 'represented', true);
        await this.publish(plan.id, {
          type: 'bubble_joined',
          bubble: {
            userId: m.userId,
            displayName: user?.displayName ?? m.userId,
            status: 'represented',
          },
        });
      } else {
        this.rt.plans.upsertMember(plan.id, m.userId, 'dropped');
        await this.publish(plan.id, { type: 'bubble_left', userId: m.userId, reason: 'dropped' });
      }
    }
  }

  private async deliberate(planId: string): Promise<void> {
    let plan = this.rt.plans.mustGet(planId);
    const participants = this.rt.plans
      .members(planId)
      .filter((m) => m.status === 'in' || m.status === 'represented');
    if (participants.length < MIN_PARTY_SIZE) {
      await this.rt.plans.transition(planId, 'CLOSED', {
        reason: `only ${participants.length} in`,
      });
      await this.publish(planId, { type: 'plan_closed', reason: 'too_few' });
      this.deps.intake?.closePlan(planId);
      await this.groupText(plan, 'too_few', `Only ${participants.length} in, so no plan tonight.`);
      return;
    }
    if (plan.state === 'GATHERING') {
      this.rt.timers.cancel(planId, 'poll_deadline');
      plan = await this.rt.plans.transition(planId, 'DELIBERATING', {
        reason: 'headcount and poll in',
      });
      this.deps.intake?.closePlan(planId);
    } else if (plan.state === 'DEADLOCK') {
      plan = await this.rt.plans.transition(planId, 'DELIBERATING', { reason: 'rerun' });
    }

    const represented = new Set(
      participants.filter((m) => m.status === 'represented').map((m) => m.userId),
    );
    const members = await this.solverMembers(
      plan,
      participants.map((m) => m.userId),
      represented,
    );
    const startMinutes = plan.startAt
      ? this.minutesOf(plan.startAt)
      : (plan.intent.startMinutes ?? SOLVER.default_start_min);
    const ctx = this.ctx(plan, startMinutes);
    const result = solve({
      venues: this.rt.venues(),
      members,
      ctx,
      vetoedVenueIds: [...(this.vetoed.get(planId) ?? [])],
    });
    const byReason: Record<string, number> = {};
    const byMember: Record<string, Record<string, number>> = {};
    for (const i of result.infeasible) {
      byReason[i.reason] = (byReason[i.reason] ?? 0) + 1;
      if (i.userId) {
        const m = (byMember[i.userId] ??= {});
        m[i.reason] = (m[i.reason] ?? 0) + 1;
      }
    }
    this.rt.plans.audit(planId, 'solver_run', {
      feasible: result.feasible.length,
      infeasible: result.infeasible.length,
      byReason,
      byMember,
      ctx: {
        startMinutes: ctx.startMinutes,
        style: ctx.style ?? null,
        cuisine: ctx.cuisine ?? null,
        members: members.length,
      },
      rounds: result.rounds.length,
      winner: result.winner?.id ?? null,
      backup: result.backup?.id ?? null,
    });

    for (const v of result.feasible)
      await this.publish(planId, { type: 'candidate_added', venue: pageVenue(v) });
    const base = this.roundsSoFar(planId);
    for (const round of result.rounds) {
      await this.publish(planId, {
        type: 'round_complete',
        round: base + round.round,
        scores: round.scores.map((s) => ({ userId: s.userId, venueId: s.venueId, score: s.score })),
        bubbles: round.bubbles,
        leaderVenueId: round.leaderVenueId,
      });
      if (round.eliminated) {
        await this.publish(planId, {
          type: 'candidate_eliminated',
          venueId: round.eliminated.venueId,
          round: base + round.round,
          reason: 'least_support',
        });
      }
    }

    if (!result.winner) {
      // 1. A small concession that keeps the cuisine beats changing the cuisine: ask that person.
      if (ctx.cuisine && this.hasConcession(planId, plan, members, ctx)) {
        await this.rt.plans.transition(planId, 'DEADLOCK', { reason: 'no venue fits everyone' });
        await this.breakDeadlock(planId, members, ctx);
        return;
      }
      // 2. Nothing of that cuisine can work: ask the people who chose it about the best other pick.
      if (await this.askCuisineSwitch(plan, members, ctx)) return;
      // 3. Concessions without the cuisine, then a time shift, then options.
      await this.rt.plans.transition(planId, 'DEADLOCK', { reason: 'no venue fits everyone' });
      await this.breakDeadlock(planId, members, { ...ctx, cuisine: null });
      return;
    }

    const startAt = this.startAtIso(plan.intent.date, startMinutes);
    await this.publish(planId, {
      type: 'bubble_merged',
      userIds: members.map((m) => m.userId),
      venueId: result.winner.id,
    });
    this.rt.plans.setChoice(planId, {
      chosenVenueId: result.winner.id,
      backupVenueId: result.backup?.id ?? null,
      startAt,
    });
    await this.rt.plans.transition(planId, 'LOCKED', {
      reason: `winner ${result.winner.name}${result.backup ? `, backup ${result.backup.name}` : ''}`,
    });
    this.mark(planId, 't_lock');
    await this.publish(planId, {
      type: 'plan_locked',
      venue: pageVenue(result.winner),
      backup: result.backup ? pageVenue(result.backup) : null,
      startAt,
      partySize: members.length,
    });
    const vetoSeconds = Math.round(this.rt.timers.deadlines.veto_window_ms / 1000);
    await this.groupText(
      this.rt.plans.mustGet(planId),
      'locked',
      `${result.winner.name} at ${this.localClock(startAt)} for ${members.length}${result.backup ? `, backup ${result.backup.name}` : ''}. Say "veto" in the next ${vetoSeconds} s or I call them.`,
    );
    this.rt.timers.schedule({ planId, kind: 'veto_window', replace: true });
  }

  private async rerun(planId: string, reason: string): Promise<void> {
    const plan = this.rt.plans.mustGet(planId);
    this.rt.timers.cancel(planId, 'veto_window');
    if (plan.state !== 'DELIBERATING')
      await this.rt.plans.transition(planId, 'DELIBERATING', { reason });
    await this.deliberate(planId);
  }

  private async book(planId: string): Promise<void> {
    const plan = this.rt.plans.mustGet(planId);
    if (!plan.chosenVenueId || !plan.startAt)
      throw new Error(`plan ${planId} has no choice to book`);
    const venue = this.rt.venues().find((v) => v.id === plan.chosenVenueId);
    const backup = this.rt.venues().find((v) => v.id === plan.backupVenueId) ?? null;
    if (!venue) throw new Error(`venue ${plan.chosenVenueId} missing`);
    const members = this.rt.plans.members(planId);
    const party = members.filter((m) => m.status === 'in' || m.status === 'represented');
    const organizer = await this.rt.crews.userById(plan.createdByUserId);
    const reservationName = organizer?.displayName ?? 'Bubbleworks';
    const bookingId = newId('booking');
    const key = idempotencyKey(planId, 'book', venue.id, plan.startAt);
    const at = this.now().toISOString();
    this.rt.db
      .insert(bookings)
      .values({
        id: bookingId,
        planId,
        venueId: venue.id,
        backupVenueId: backup?.id ?? null,
        status: 'dialing',
        partySize: party.length,
        startAt: plan.startAt,
        reservationName,
        idempotencyKey: key,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    await this.rt.plans.transition(planId, 'BOOKING', { reason: 'veto window passed' });
    this.mark(planId, 't_dial');
    await this.publish(planId, {
      type: 'doer_status',
      doer: 'caller',
      state: 'started',
      detail: `Calling ${venue.name}`,
    });
    const dial = (v: Venue) =>
      this.deps.callRedirectPhone ? { ...v, phone: this.deps.callRedirectPhone } : v;
    const handle = await this.deps.caller.book({
      planId,
      bookingId,
      venue: dial(venue),
      backupVenue: backup ? dial(backup) : backup,
      partySize: party.length,
      startAt: plan.startAt,
      reservationName,
      tableNotes: await this.tableNotes(party),
      idempotencyKey: key,
    });
    this.rt.db
      .update(bookings)
      .set({
        callId: handle.callId,
        status: handle.status === 'in_call' ? 'in_call' : 'dialing',
        updatedAt: this.now().toISOString(),
      })
      .where(eq(bookings.id, bookingId))
      .run();
    this.rt.timers.schedule({
      planId,
      kind: 'call_timeout',
      payload: { bookingId },
      replace: true,
    });
  }

  private async fireDoers(plan: Plan, summary: BookingSummary): Promise<void> {
    const run = async (
      doer: 'inviter' | 'splitter',
      fn: () => Promise<{ ok: boolean; detail?: string }>,
    ) => {
      await this.publish(plan.id, { type: 'doer_status', doer, state: 'started' });
      try {
        const r = await fn();
        await this.publish(plan.id, {
          type: 'doer_status',
          doer,
          state: r.ok ? 'done' : 'failed',
          ...(r.detail ? { detail: r.detail.slice(0, 120) } : {}),
        });
      } catch (err) {
        this.log.error({ err: String(err), planId: plan.id, doer }, 'doer failed');
        await this.publish(plan.id, { type: 'doer_status', doer, state: 'failed' });
      }
    };
    await run('inviter', () =>
      this.deps.doers.inviter.send({
        ...summary,
        idempotencyKey: idempotencyKey(plan.id, 'inviter', summary.bookingId),
      }),
    );
    await run('splitter', () =>
      this.deps.doers.splitter.send({
        ...summary,
        idempotencyKey: idempotencyKey(plan.id, 'splitter', summary.bookingId),
      }),
    );
    await this.deps.doers.watcher.start(summary);
    await this.publish(plan.id, {
      type: 'doer_status',
      doer: 'watcher',
      state: 'working',
      detail: 'Watching for changes',
    });
  }

  /** The organizer's answer to a deposit request. Yes books it under their name; no moves on. */
  private async answerDeposit(
    plan: Plan,
    askId: string,
    answer: 'yes' | 'no',
    at: string,
  ): Promise<void> {
    this.rt.db
      .update(asks)
      .set({ status: answer === 'yes' ? 'accepted' : 'declined', resolvedAt: at })
      .where(eq(asks.id, askId))
      .run();
    await this.publish(plan.id, {
      type: 'private_ask_resolved',
      askId,
      outcome: answer === 'yes' ? 'accepted' : 'declined',
    });
    const booking = this.rt.db
      .select()
      .from(bookings)
      .where(and(eq(bookings.planId, plan.id), eq(bookings.status, 'needs_human')))
      .get();
    if (!booking) return;
    const venue = this.rt.venues().find((v) => v.id === booking.venueId);
    if (answer === 'yes') {
      this.rt.db
        .update(bookings)
        .set({ status: 'booked', notes: 'deposit approved by organizer', updatedAt: at })
        .where(eq(bookings.id, booking.id))
        .run();
      if (plan.state === 'BOOKING')
        await this.rt.plans.transition(plan.id, 'BOOKED', {
          reason: 'organizer approved the deposit',
        });
      await this.publish(plan.id, {
        type: 'doer_status',
        doer: 'caller',
        state: 'done',
        detail: 'Deposit approved',
      });
      if (venue) {
        await this.publish(plan.id, {
          type: 'booking_confirmed',
          bookingId: booking.id,
          venue: pageVenue(venue),
          startAt: booking.startAt,
          partySize: booking.partySize,
          reservationName: booking.reservationName,
        });
      }
      await this.groupText(
        plan,
        'booked',
        `Booked at ${venue?.name ?? 'the place'}; the organizer is handling the deposit.`,
      );
      return;
    }
    this.rt.db
      .update(bookings)
      .set({ status: 'failed', notes: 'deposit declined', updatedAt: at })
      .where(eq(bookings.id, booking.id))
      .run();
    this.addVetoed(plan.id, booking.venueId);
    if (plan.state === 'BOOKING') {
      await this.rt.plans.transition(plan.id, 'DELIBERATING', { reason: 'deposit declined' });
      await this.deliberate(plan.id);
    }
  }

  // -- deadlock breaker ----------------------------------------------------------

  private async breakDeadlock(
    planId: string,
    members: SolverMember[],
    ctx: SolverContext,
  ): Promise<void> {
    const plan = this.rt.plans.mustGet(planId);
    const vetoed = this.vetoed.get(planId) ?? new Set<string>();
    const analysis = analyzeDeadlock(
      this.rt.venues().filter((v) => !vetoed.has(v.id)),
      members,
      ctx,
      {
        minStartMinutes: earliestStart(plan.intent.date, this.tz, this.planNow()),
      },
    );
    const picks = pickAsks(analysis);
    this.rt.plans.audit(planId, 'deadlock_analysis', {
      concessions: analysis.concessions.map((c) => ({
        userId: c.userId,
        kind: c.kind,
        steps: c.steps,
        cost: c.cost,
      })),
      timeShift: analysis.timeShift ? analysis.timeShift.startMinutes : null,
      asked: picks.map((c) => c.userId),
    });
    if (picks.length === 0) {
      await this.noFit(
        planId,
        analysis.timeShift ? { startMinutes: analysis.timeShift.startMinutes } : null,
      );
      return;
    }
    await this.groupText(
      plan,
      'deadlock',
      'Nothing fits everyone yet. Checking privately whether something small can give.',
    );
    const names = new Map(members.map((m) => [m.userId, m.displayName]));
    const at = this.now().toISOString();
    const expiresAt = new Date(
      this.now().getTime() + this.rt.timers.deadlines.private_ask_ms,
    ).toISOString();
    for (const c of picks) {
      const venue = this.rt.venues().find((v) => v.id === c.enablesVenueIds[0]);
      const text = await this.askWriter.write({
        kind: c.kind,
        from: c.from,
        to: c.to,
        venueName: venue?.name ?? 'a place nearby',
        meal: plan.intent.meal,
        firstName: names.get(c.userId) ?? 'there',
        forbiddenNames: [...names.entries()].filter(([id]) => id !== c.userId).map(([, n]) => n),
      });
      const askId = newId('ask');
      const key = idempotencyKey(planId, 'ask', askId);
      this.rt.db
        .insert(asks)
        .values({
          id: askId,
          planId,
          userId: c.userId,
          kind: c.kind,
          concession: {
            factType: c.kind === 'budget' ? 'budget_max' : 'other',
            from: String(c.from),
            to: String(c.to),
            cost: c.cost,
          },
          text,
          status: 'pending',
          idempotencyKey: key,
          sentAt: at,
          expiresAt,
        })
        .run();
      await this.publish(planId, { type: 'private_ask_sent', askId });
      await this.deps.messaging.sendPrivateText({ userId: c.userId, text, idempotencyKey: key });
    }
    this.rt.timers.schedule({ planId, kind: 'ask_timeout', replace: true });
  }

  private async onAskTimeout(t: FiredTimer): Promise<void> {
    const plan = this.rt.plans.get(t.planId);
    if (!plan || plan.state !== 'DEADLOCK') return;
    const at = this.now().toISOString();
    const pending = this.rt.db
      .select()
      .from(asks)
      .where(and(eq(asks.planId, plan.id), eq(asks.status, 'pending')))
      .all();
    for (const a of pending) {
      this.rt.db
        .update(asks)
        .set({ status: 'expired', resolvedAt: at })
        .where(eq(asks.id, a.id))
        .run();
      await this.publish(plan.id, {
        type: 'private_ask_resolved',
        askId: a.id,
        outcome: 'expired',
      });
    }
    await this.afterAsksResolved(plan.id);
  }

  /** When no ask is pending any more and none was accepted, fall back to a time shift or takeout. */
  private async afterAsksResolved(planId: string): Promise<void> {
    const plan = this.rt.plans.get(planId);
    if (!plan || plan.state !== 'DEADLOCK') return;
    const every = this.rt.db.select().from(asks).where(eq(asks.planId, planId)).all();
    if (every.some((a) => a.status === 'pending')) return;
    const all = every.filter((a) => a.kind !== 'cuisine');
    if (all.length === 0 && every.length > 0) {
      // Only the cuisine question was out: its answers decide, then the solver runs.
      await this.deliberate(planId);
      return;
    }
    if (all.some((a) => a.status === 'accepted')) return;
    this.rt.timers.cancel(planId, 'ask_timeout');
    const participants = this.rt.plans
      .members(planId)
      .filter((m) => m.status === 'in' || m.status === 'represented');
    const members = await this.solverMembers(
      plan,
      participants.map((m) => m.userId),
      new Set(participants.filter((m) => m.status === 'represented').map((m) => m.userId)),
    );
    const startMinutes = plan.startAt
      ? this.minutesOf(plan.startAt)
      : (plan.intent.startMinutes ?? SOLVER.default_start_min);
    const analysis = analyzeDeadlock(this.rt.venues(), members, this.ctx(plan, startMinutes), {
      minStartMinutes: earliestStart(plan.intent.date, this.tz, this.planNow()),
    });
    await this.noFit(
      planId,
      analysis.timeShift ? { startMinutes: analysis.timeShift.startMinutes } : null,
    );
  }

  private async noFit(planId: string, shift: { startMinutes: number } | null): Promise<void> {
    const plan = this.rt.plans.mustGet(planId);
    if (shift) {
      const startAt = this.startAtIso(plan.intent.date, shift.startMinutes);
      this.rt.plans.setChoice(planId, { chosenVenueId: null, backupVenueId: null, startAt });
      await this.groupText(plan, 'time_shift', noFitText('time', this.localClock(startAt)));
      await this.rt.plans.transition(planId, 'DELIBERATING', {
        reason: `time shifted to ${this.localClock(startAt)}`,
      });
      await this.deliberate(planId);
      return;
    }
    await this.groupText(plan, 'no_fit', noFitText('takeout'));
    await this.rt.plans.transition(planId, 'CLOSED', {
      reason: 'no venue fits and nobody could stretch',
    });
    await this.publish(planId, { type: 'plan_closed', reason: 'failed' });
    this.deps.intake?.closePlan(planId);
  }

  private acceptedSlack(planId: string, userId: string): SolverMember['slack'] {
    const rows = this.rt.db
      .select()
      .from(asks)
      .where(and(eq(asks.planId, planId), eq(asks.userId, userId), eq(asks.status, 'accepted')))
      .all();
    let budgetUsd = 0;
    let travelMin = 0;
    for (const r of rows) {
      if (!r.concession) continue;
      const delta = Number(r.concession.to) - Number(r.concession.from);
      if (r.kind === 'budget') budgetUsd = Math.max(budgetUsd, delta);
      if (r.kind === 'distance') travelMin = Math.max(travelMin, delta);
    }
    return budgetUsd || travelMin ? { budgetUsd, travelMin } : undefined;
  }

  // -- helpers -------------------------------------------------------------------

  private async solverMembers(
    plan: Plan,
    userIds: string[],
    represented: Set<string>,
  ): Promise<Array<SolverMember & { busy: Awaited<ReturnType<BubbleService['getFreeBusy']>> }>> {
    const spec = this.pollSpec(plan.id)?.cuisine ?? null;
    const choices = new Map<string, string[]>();
    if (spec) {
      for (const row of this.rt.db
        .select()
        .from(votes)
        .where(eq(votes.pollId, spec.pollId))
        .all()) {
        choices.set(row.userId, [...(choices.get(row.userId) ?? []), row.choice]);
      }
    }
    const dayStart = zonedInstant(plan.intent.date, 16 * 60, this.tz);
    const dayEnd = zonedInstant(plan.intent.date, 22 * 60, this.tz);
    const out = [];
    for (const userId of userIds) {
      const profile = await this.deps.bubbles.getProfile(userId);
      const busy = await this.deps.bubbles.getFreeBusy(userId, {
        start: new Date(dayStart).toISOString(),
        end: new Date(dayEnd).toISOString(),
      });
      out.push({
        userId,
        displayName: profile.user.displayName,
        hardFacts: profile.facts.filter((f: Fact) => f.hard),
        softFacts: profile.facts.filter((f: Fact) => !f.hard),
        pollChoices: choices.get(userId) ?? [],
        location: this.reachableLocation(
          plan.id,
          userId,
          await this.deps.bubbles.getLocation(userId),
        ),
        recentVenueIds: profile.recentVenueIds,
        recentCompromiseCount: profile.recentCompromiseCount,
        represented: represented.has(userId),
        slack: this.acceptedSlack(plan.id, userId),
        busy,
      });
    }
    return out;
  }

  /**
   * A live fix farther than every venue can be stretched to (a stale Find My point, someone still
   * driving in) would sink the whole plan on distance. Plan from the group's area instead.
   */
  private reachableLocation(
    planId: string,
    userId: string,
    location: GeoPoint | null,
  ): GeoPoint | null {
    if (!location) return null;
    const venues = this.rt.venues();
    if (venues.length === 0) return location;
    const nearest = Math.min(...venues.map((v) => walkMinutes(distanceM(location, v.location))));
    if (nearest <= this.travelLimit() + MAX_DISTANCE_SLACK_MIN) return location;
    this.log.info(
      { planId, userId, nearestWalkMin: nearest },
      'location out of reach of every venue, planning from the group area',
    );
    return null;
  }

  private ctx(plan: Plan, startMinutes: number): SolverContext {
    return {
      day: dayOfWeek(plan.intent.date),
      startMinutes,
      groupCenter: this.groupCenter(plan.groupId),
      meal: plan.intent.meal,
      // Agent-first plans are for places you book: sit-down unless the message says otherwise.
      style:
        this.decidedStyle(plan) ??
        (this.agentFirst() && plan.intent.meal !== 'coffee' ? 'sit_down' : null),
      cuisine: this.decidedCuisine(plan),
      travelLimitMin: this.travelLimit(),
    };
  }

  /** Could a budget or distance concession by one person make something feasible as is? */
  private hasConcession(
    planId: string,
    plan: Plan,
    members: SolverMember[],
    ctx: SolverContext,
  ): boolean {
    const vetoed = this.vetoed.get(planId) ?? new Set<string>();
    const analysis = analyzeDeadlock(
      this.rt.venues().filter((v) => !vetoed.has(v.id)),
      members,
      ctx,
      { minStartMinutes: earliestStart(plan.intent.date, this.tz, this.planNow()) },
    );
    return pickAsks(analysis).length > 0;
  }

  /** Live restaurants for this plan: the crew's area, within reach, the named cuisine if any. */
  private async refreshVenues(plan: Plan): Promise<void> {
    const source = this.deps.venueSource;
    const center = this.groupCenter(plan.groupId);
    if (!source || !center) return;
    const t0 = Date.now();
    const cuisine = plan.intent.cuisine ?? null;
    try {
      const found = await source.search({
        center,
        radiusM: this.travelLimit() * 80,
        cuisine,
        meal: plan.intent.meal,
      });
      const added = this.rt.addVenues(found);
      this.log.info(
        { planId: plan.id, cuisine, found: found.length, added, ms: Date.now() - t0 },
        'live venues',
      );
      this.rt.plans.audit(plan.id, 'live_venues', {
        cuisine,
        found: found.length,
        ms: Date.now() - t0,
      });
    } catch (err) {
      this.log.warn(
        { planId: plan.id, cuisine, err: (err as Error).message, ms: Date.now() - t0 },
        'live venue search failed, using stored venues',
      );
    }
  }

  private agentFirst(): boolean {
    return this.deps.flow === 'agent_first';
  }

  /** Walking minutes a member may be from a venue: a short walk, or a drive when agent-first. */
  private travelLimit(): number {
    return this.agentFirst() ? AGENT_FIRST_REACH_MIN : SOLVER.travel_limit_min;
  }

  /** Cuisine from the message, else the cuisine poll's leader, else no constraint. */
  private decidedCuisine(plan: Plan): string | null {
    if (this.cuisineSwitch(plan.id) === 'switch') return null;
    if (plan.intent.cuisine) return plan.intent.cuisine;
    const spec = this.pollSpec(plan.id)?.cuisine;
    return spec ? this.pollLeader(plan.id, spec) : null;
  }

  /**
   * Where the "nothing <cuisine> in range, OK to switch?" question stands. Silence counts as yes;
   * the cuisine stays only when more of its voters said no than yes.
   */
  private cuisineSwitch(planId: string): 'none' | 'pending' | 'switch' | 'keep' {
    if (this.cuisineDropped.has(planId)) return 'switch';
    const rows = this.rt.db
      .select()
      .from(asks)
      .where(and(eq(asks.planId, planId), eq(asks.kind, 'cuisine')))
      .all();
    if (rows.length === 0) return 'none';
    if (rows.some((r) => r.status === 'pending')) return 'pending';
    const no = rows.filter((r) => r.status === 'declined').length;
    return no > rows.length - no ? 'keep' : 'switch';
  }

  /**
   * The decided cuisine has nothing in range: tell the table, ask the people who chose it whether
   * the best other pick is OK, and wait. Returns true when the plan is now waiting on them.
   */
  private async askCuisineSwitch(
    plan: Plan,
    members: SolverMember[],
    ctx: SolverContext,
  ): Promise<boolean> {
    const cuisine = ctx.cuisine;
    if (!cuisine || this.cuisineSwitch(plan.id) !== 'none') return false;
    const vetoed = this.vetoed.get(plan.id) ?? new Set<string>();
    const venues = this.rt.venues().filter((v) => !vetoed.has(v.id));
    if (filterCandidates(venues, members, ctx).feasible.length > 0) return false;
    const fallback = solve({ venues, members, ctx: { ...ctx, cuisine: null } }).winner;
    // Nothing fits even without the cuisine: the deadlock breaker takes it from here.
    if (!fallback) {
      this.log.info({ planId: plan.id, cuisine }, 'nothing fits even without the voted cuisine');
      return false;
    }

    const label = cuisineLabel(cuisine);
    const spec = this.pollSpec(plan.id)?.cuisine;
    const voters = new Set<string>(
      spec
        ? this.rt.db
            .select()
            .from(votes)
            .where(and(eq(votes.pollId, spec.pollId), eq(votes.choice, cuisine)))
            .all()
            .map((v) => v.userId)
        : [plan.createdByUserId],
    );
    const askable = members.filter((m) => voters.has(m.userId) && !m.represented);
    this.log.info(
      { planId: plan.id, cuisine, fallback: fallback.id, asked: askable.length },
      'voted cuisine out of range',
    );
    if (askable.length === 0) {
      this.cuisineDropped.add(plan.id);
      return false;
    }

    if (plan.state !== 'DEADLOCK') {
      await this.rt.plans.transition(plan.id, 'DEADLOCK', { reason: `no ${cuisine} in range` });
    }
    const at = this.now().toISOString();
    const expiresAt = new Date(
      this.now().getTime() + this.rt.timers.deadlines.private_ask_ms,
    ).toISOString();
    const named = !!plan.intent.cuisine;
    const text = cuisineSwitchAsk(label, fallback.name, named);
    for (const m of askable) {
      const askId = newId('ask');
      const key = idempotencyKey(plan.id, 'ask', askId);
      this.rt.db
        .insert(asks)
        .values({
          id: askId,
          planId: plan.id,
          userId: m.userId,
          kind: 'cuisine',
          concession: { factType: 'other', from: cuisine, to: fallback.cuisine, cost: 1 },
          text,
          status: 'pending',
          idempotencyKey: key,
          sentAt: at,
          expiresAt,
        })
        .run();
      await this.publish(plan.id, { type: 'private_ask_sent', askId });
      await this.deps.messaging.sendPrivateText({ userId: m.userId, text, idempotencyKey: key });
    }
    const notice = cuisineSwitchNotice(label, fallback.name, named);
    for (const m of members) {
      if (askable.some((a) => a.userId === m.userId)) continue;
      await this.deps.messaging.sendPrivateText({
        userId: m.userId,
        text: notice,
        idempotencyKey: idempotencyKey(plan.id, 'cuisine_notice', m.userId),
      });
    }
    this.rt.timers.schedule({ planId: plan.id, kind: 'ask_timeout', replace: true });
    return true;
  }

  private async answerCuisineSwitch(
    plan: Plan,
    askId: string,
    userId: string,
    answer: 'yes' | 'no',
    at: string,
  ): Promise<void> {
    const outcome = answer === 'yes' ? 'accepted' : 'declined';
    this.rt.db
      .update(asks)
      .set({ status: outcome, resolvedAt: at })
      .where(eq(asks.id, askId))
      .run();
    await this.publish(plan.id, { type: 'private_ask_resolved', askId, outcome });
    if (answer === 'yes') {
      this.rt.db
        .insert(ledger)
        .values({
          id: newId('ledger'),
          groupId: plan.groupId,
          planId: plan.id,
          userId,
          kind: 'compromised',
          amount: 1,
          note: 'cuisine switch',
          at,
        })
        .run();
    }
    await this.deps.messaging.sendPrivateText({
      userId,
      text: answer === 'yes' ? 'Thanks, switching.' : 'Got it.',
      idempotencyKey: idempotencyKey(plan.id, 'cuisine_answer', askId),
    });
    if (this.cuisineSwitch(plan.id) === 'pending') return;
    this.rt.timers.cancel(plan.id, 'ask_timeout');
    await this.deliberate(plan.id);
  }

  /** Style from the message, else the style poll's leader, else no constraint. */
  private decidedStyle(plan: Plan): VenueStyle | null {
    const override = this.styleOverride.get(plan.id);
    if (override) return override;
    if (plan.intent.style) return plan.intent.style;
    const spec = this.pollSpec(plan.id)?.style;
    if (!spec) return null;
    const leader = this.pollLeader(plan.id, spec);
    return leader === 'sit_down' || leader === 'fast_food' ? leader : null;
  }

  /** The poll's decided leader, else a plurality with at least one vote and no tie. */
  private pollLeader(planId: string, spec: PollSpec): string | null {
    const { decision, counts } = this.tally(planId, spec);
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    const plurality = top && top[1] > 0 && (ranked[1]?.[1] ?? 0) < top[1] ? top[0] : null;
    return decision.leader ?? plurality;
  }

  /** A crew declared over DM has no center yet: plan around the hackathon until pins say otherwise. */
  private groupCenter(groupId: string): GeoPoint | null {
    return groupById(this.rt.db, groupId)?.center ?? { ...HACKATHON_CENTER };
  }

  private pollSpec(planId: string, payload?: Record<string, unknown>): PlanPolls | null {
    const cached = this.polls.get(planId);
    if (cached) return cached;
    const raw =
      payload ??
      (this.rt.timers.pending(planId).find((t) => t.kind === 'poll_deadline')?.payload as
        Record<string, unknown> | undefined);
    if (!raw) return null;
    const cuisine =
      typeof raw['pollId'] === 'string'
        ? { pollId: raw['pollId'], options: (raw['options'] as PollOption[]) ?? [] }
        : null;
    const style =
      typeof raw['stylePollId'] === 'string'
        ? { pollId: raw['stylePollId'], options: (raw['styleOptions'] as PollOption[]) ?? [] }
        : null;
    if (!cuisine && !style) return null;
    const polls = { style, cuisine };
    this.polls.set(planId, polls);
    return polls;
  }

  private tally(planId: string, spec: PollSpec) {
    const rows = this.rt.db.select().from(votes).where(eq(votes.pollId, spec.pollId)).all();
    const byVoter: Record<string, string[]> = {};
    for (const r of rows) (byVoter[r.userId] ??= []).push(r.choice);
    const counts = tallyChoices(
      byVoter,
      spec.options.map((o) => o.key),
    );
    const voters = this.rt.plans
      .members(planId)
      .filter((m) => m.status === 'in' || m.status === 'invited');
    const remaining = voters.filter((m) => !byVoter[m.userId]).length;
    return { counts, decision: isPollDecided(counts, remaining), remaining };
  }

  /**
   * The style is decided: rebuild the cuisine poll from the people who are in, their limits,
   * and that style, so every option has a real place behind it. If the style fits nobody at the
   * table, say so and offer the other style's cuisines. One cuisine left: no poll. None at all:
   * no poll, and deliberation's deadlock breaker asks the right people to give.
   */
  private async prepareCuisinePoll(plan: Plan): Promise<void> {
    const polls = this.pollSpec(plan.id);
    const spec = polls?.cuisine;
    // Only the staged bundle (P2's intake) sends the cuisine poll after the style vote.
    if (!polls || !spec || this.closedPolls.has(spec.pollId) || !this.deps.intake?.updatePoll)
      return;
    const participants = this.rt.plans
      .members(plan.id)
      .filter((m) => m.status === 'in' || m.status === 'represented');
    const members = await this.solverMembers(
      plan,
      participants.map((m) => m.userId),
      new Set(participants.filter((m) => m.status === 'represented').map((m) => m.userId)),
    );
    const startMinutes = plan.startAt
      ? this.minutesOf(plan.startAt)
      : (plan.intent.startMinutes ?? SOLVER.default_start_min);
    const base = { ...this.ctx(plan, startMinutes), cuisine: null };
    const vetoed = this.vetoed.get(plan.id) ?? new Set<string>();
    const venues = this.rt.venues().filter((v) => !vetoed.has(v.id));
    const fits = (style: VenueStyle | null) =>
      filterCandidates(venues, members, { ...base, style }).feasible;

    let feasible = fits(base.style ?? null);
    if (feasible.length === 0 && base.style) {
      const other: VenueStyle = base.style === 'fast_food' ? 'sit_down' : 'fast_food';
      const instead = fits(other);
      if (instead.length > 0) {
        this.styleOverride.set(plan.id, other);
        this.rt.plans.audit(plan.id, 'style_override', { from: base.style, to: other });
        await this.groupText(plan, 'style_override', styleOverrideText(base.style, other));
        feasible = instead;
      }
    }
    const options = cuisineOptions(feasible, members, { ...base, style: this.decidedStyle(plan) });
    this.log.info(
      { planId: plan.id, style: this.decidedStyle(plan), options: options.map((o) => o.key) },
      'cuisine options',
    );
    if (options.length < 2) {
      // Nothing to choose between: drop the question and go straight to the search.
      this.closedPolls.add(spec.pollId);
      this.deps.intake?.updatePoll?.(plan.id, spec.pollId, null);
      this.rt.plans.audit(plan.id, 'poll_skipped', {
        pollId: spec.pollId,
        options: options.map((o) => o.key),
      });
      return;
    }
    spec.options = options;
    this.deps.intake?.updatePoll?.(plan.id, spec.pollId, options);
    // The cuisine question gets a full answer window of its own.
    this.rt.timers.schedule({
      planId: plan.id,
      kind: 'poll_deadline',
      replace: true,
      payload: {
        pollId: spec.pollId,
        options,
        ...(polls.style
          ? { stylePollId: polls.style.pollId, styleOptions: polls.style.options }
          : {}),
      },
    });
  }

  private async closePoll(plan: Plan, spec: PollSpec, leader: string | null): Promise<void> {
    this.closedPolls.add(spec.pollId);
    this.rt.plans.audit(plan.id, 'poll_closed', { pollId: spec.pollId, leader });
    // Closing the style poll sends the cuisine poll next, so build its options first.
    if (this.pollSpec(plan.id)?.style?.pollId === spec.pollId) {
      await this.prepareCuisinePoll(plan);
    }
    try {
      await this.deps.messaging.closePoll({ chatId: plan.chatId, pollId: spec.pollId });
    } catch (err) {
      this.log.warn({ err: String(err), planId: plan.id }, 'closePoll failed');
    }
    if (leader) this.log.info({ planId: plan.id, leader: cuisineLabel(leader) }, 'poll decided');
  }

  private addVetoed(planId: string, venueId: string): void {
    const set = this.vetoed.get(planId) ?? new Set<string>();
    set.add(venueId);
    this.vetoed.set(planId, set);
    this.rt.plans.audit(planId, 'venue_vetoed', { venueId });
  }

  /** Rounds already published for this plan, so reruns keep numbering upward for the page. */
  private roundsSoFar(planId: string): number {
    return this.rt.db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.planId, planId), eq(events.type, 'round_complete')))
      .all().length;
  }

  private async tableNotes(party: PlanMember[]): Promise<string[]> {
    const counts = new Map<string, number>();
    for (const m of party) {
      for (const f of await this.deps.bubbles.getHardLimits(m.userId)) {
        if (f.type === 'allergy') counts.set(f.value, (counts.get(f.value) ?? 0) + 1);
      }
    }
    // Aggregates only across three or more people; never attributed.
    return party.length >= MIN_AGGREGATE_GROUP_SIZE
      ? [...counts.keys()].sort().map((a) => `${a} allergy at the table`)
      : [];
  }

  private explain(plan: Plan): string {
    const venue = plan.chosenVenueId
      ? this.rt.venues().find((v) => v.id === plan.chosenVenueId)
      : null;
    const backup = plan.backupVenueId
      ? this.rt.venues().find((v) => v.id === plan.backupVenueId)
      : null;
    const party = this.rt.plans.inCount(plan.id);
    switch (plan.state) {
      case 'GATHERING':
        return `Waiting on the headcount and the poll. ${party} in so far.`;
      case 'DELIBERATING':
      case 'DEADLOCK':
        return `Comparing places that work for all ${party} of you: open tonight, right food, right price, walkable.`;
      case 'LOCKED':
      case 'BOOKING':
      case 'BOOKED':
        return `${venue?.name ?? 'The pick'} fit every bubble's limits and had the most support across ${party} people${backup ? `; ${backup.name} is the backup` : ''}. Nobody's private details leave the server.`;
      default:
        return `The plan is ${plan.state.toLowerCase()}.`;
    }
  }

  private async renderPlainBundle(r: BundleRequest): Promise<void> {
    await this.deps.messaging.sendGroupText({
      chatId: r.chatId,
      text: headcountText(r),
      idempotencyKey: idempotencyKey(r.planId, 'headcount'),
    });
    if (r.stylePoll) {
      await this.deps.messaging.sendPoll({
        chatId: r.chatId,
        planId: r.planId,
        pollId: r.stylePoll.pollId,
        question: 'Sit-down or fast food?',
        options: r.stylePoll.options,
        idempotencyKey: idempotencyKey(r.planId, 'poll', r.stylePoll.pollId),
      });
    }
    if (r.cuisinePoll) {
      await this.deps.messaging.sendPoll({
        chatId: r.chatId,
        planId: r.planId,
        pollId: r.cuisinePoll.pollId,
        question: 'What are we feeling?',
        options: r.cuisinePoll.options,
        idempotencyKey: idempotencyKey(r.planId, 'poll', r.cuisinePoll.pollId),
      });
    }
    if (r.pageUrl) {
      await this.deps.messaging.sendRichLink({
        chatId: r.chatId,
        url: r.pageUrl,
        title: 'Watch the bubbles decide',
        idempotencyKey: idempotencyKey(r.planId, 'link'),
      });
    }
  }

  private async groupText(plan: Plan, action: string, text: string): Promise<void> {
    await this.deps.messaging.sendGroupText({
      chatId: plan.chatId,
      text,
      idempotencyKey: idempotencyKey(plan.id, action),
    });
  }

  private publish(planId: string, event: Record<string, unknown> & { type: string }) {
    return this.rt.bus.publish({ ...event, planId, at: this.now().toISOString() } as never);
  }

  private pageUrl(plan: Plan): string | null {
    const base = this.deps.webPublicUrl?.replace(/\/$/, '');
    return base ? `${base}/p/${plan.pageToken}` : null;
  }

  private startAtIso(date: string, minutes: number): string {
    return new Date(zonedInstant(date, minutes, this.tz)).toISOString();
  }

  private minutesOf(iso: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: this.tz,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(iso));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return get('hour') * 60 + get('minute');
  }

  private localClock(iso: string): string {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: this.tz,
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  }

  private mark(planId: string, mark: string, at = Date.now()): void {
    const t0 = this.t0.get(planId) ?? at;
    this.log.info({ planId, mark, ms: at - t0 }, 'timing');
  }
}

function pageVenue(v: Venue): PageVenue {
  return { venueId: v.id, name: v.name, cuisine: v.cuisine };
}

export { IllegalTransitionError };
