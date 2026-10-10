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
  type VoteInput,
} from '@bubbleworks/shared';
import { and, eq } from 'drizzle-orm';
import { bookings, events, votes } from '../db/schema.js';
import { groupById } from '../db/seed.js';
import { silentLogger, type Logger } from '../events/bus.js';
import type { Runtime } from '../runtime.js';
import { solve } from '../solver/rounds.js';
import type { SolverContext, SolverMember } from '../solver/types.js';
import { dayOfWeek } from '../venues/hours.js';
import { parseIntent } from './intent.js';
import {
  cuisineLabel,
  decideCuisineQuestion,
  decideStartTime,
  zonedInstant,
} from './question-policy.js';
import { IllegalTransitionError } from './state-machine.js';
import type { FiredTimer } from '../timers/service.js';

/** Structurally identical to P2's QuestionDecision so PlanIntake.renderBundle accepts it. */
export interface BundleRequest {
  planId: string;
  chatId: string;
  organizerName: string;
  meal: MealKind | null;
  dayOffset?: 0 | 1;
  cuisinePoll: { pollId: string; question?: string; options: PollOption[] } | null;
  headcount: { closesAt: string; timezone: string };
  pageUrl: string | null;
}

export interface BundleRenderer {
  renderBundle(decision: BundleRequest): Promise<unknown>;
  closePlan(planId: string): void;
}

export interface EngineDeps {
  runtime: Runtime;
  bubbles: BubbleService;
  messaging: MessagingPort;
  caller: CallerPort;
  doers: DoerPorts;
  /** P2's PlanIntake. Without it the engine renders a plain bundle through MessagingPort. */
  intake?: BundleRenderer | null;
  webPublicUrl?: string | null;
  timezone?: string;
  log?: Logger;
  now?: () => Date;
}

interface PollSpec {
  pollId: string;
  options: PollOption[];
}

export class BubbleworksEngine implements PlanEngine {
  private readonly rt: Runtime;
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly tz: string;
  private readonly polls = new Map<string, PollSpec>();
  private readonly closedPolls = new Set<string>();
  private readonly vetoed = new Map<string, Set<string>>();
  private readonly t0 = new Map<string, number>();

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
  }

  // -- PlanEngine ----------------------------------------------------------------

  async handleIntent(input: IntentInput): Promise<IntentResult> {
    const crew = await this.rt.crews.crewByChatId(input.chatId);
    if (!crew) return { planId: null, created: false };
    const active = this.rt.plans.findActiveForChat(input.chatId)[0];
    if (active) {
      this.log.info(
        { planId: active.id, state: active.state },
        'intent ignored: plan already open',
      );
      return { planId: active.id, created: false };
    }
    const started = Date.now();
    const intent = parseIntent(input.text, { now: this.now(), timezone: this.tz });
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

    // Preview with everyone in the crew so the question policy sees the whole table.
    const members = await this.solverMembers(
      plan,
      memberUsers.map((u) => u.id),
      new Set(),
    );
    const busy: Record<string, (typeof members)[number]['busy']> = {};
    for (const m of members) busy[m.userId] = m.busy;
    const time = decideStartTime(intent.startMinutes, busy, intent.date, this.tz);
    const ctx = this.ctx(plan, time.startMinutes);
    const preview = solve({ venues: this.rt.venues(), members, ctx });
    const cuisine = decideCuisineQuestion(preview.feasible, members, ctx, intent.cuisine);
    this.log.info(
      {
        planId: plan.id,
        feasible: preview.feasible.length,
        askCuisine: cuisine.ask,
        reason: cuisine.reason,
        startMinutes: time.startMinutes,
        timeTie: time.tie,
      },
      'question policy',
    );
    if (time.startMinutes !== intent.startMinutes) {
      this.rt.plans.setChoice(plan.id, {
        chosenVenueId: null,
        backupVenueId: null,
        startAt: this.startAtIso(intent.date, time.startMinutes),
      });
    }

    const poll: PollSpec | null = cuisine.ask
      ? { pollId: newId('poll'), options: cuisine.options }
      : null;
    if (poll) this.polls.set(plan.id, poll);
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
      cuisinePoll: poll ? { pollId: poll.pollId, options: poll.options } : null,
      headcount: { closesAt, timezone: this.tz },
      pageUrl: this.pageUrl(plan),
    };
    if (this.deps.intake) await this.deps.intake.renderBundle(request);
    else await this.renderPlainBundle(request);
    this.mark(plan.id, 't_poll_posted');

    await this.rt.plans.transition(plan.id, 'GATHERING', { reason: 'bundle posted' });
    this.rt.timers.schedule({
      planId: plan.id,
      kind: 'poll_deadline',
      payload: poll ? { pollId: poll.pollId, options: poll.options } : {},
    });
    return { planId: plan.id, created: true };
  }

  async handleHeadcount(input: HeadcountInput): Promise<void> {
    const plan = this.rt.plans.get(input.planId);
    if (!plan || !['GATHERING', 'DELIBERATING', 'DEADLOCK'].includes(plan.state)) return;
    const before = this.rt.plans.members(plan.id).find((m) => m.userId === input.userId);
    const status = input.in ? 'in' : 'out';
    if (before?.status === status) return;
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
    } else {
      await this.publish(plan.id, { type: 'bubble_left', userId: input.userId, reason: 'out' });
    }
    if (plan.state === 'GATHERING') await this.maybeAdvance(plan.id);
  }

  async handleVote(input: VoteInput): Promise<void> {
    const plan = this.rt.plans.get(input.planId);
    if (!plan || plan.state !== 'GATHERING') return;
    const spec = this.pollSpec(plan.id);
    if (!spec || spec.pollId !== input.pollId) return;
    const at = input.at;
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
            kind: 'cuisine',
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

  async handleAskAnswer(input: AskAnswerInput): Promise<void> {
    // Phase 3: deadlock breaker resolves concession asks here.
    this.rt.plans.audit(null, 'ask_answer_unhandled', { askId: input.askId, answer: input.answer });
    this.log.warn({ askId: input.askId }, 'ask answer received before the deadlock breaker exists');
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
          detail: 'The restaurant needs a person',
        });
        await this.privateText(
          plan,
          plan.createdByUserId,
          'needs_human',
          `${result.summary} Reply "yes" to go ahead or "no" to pick somewhere else.`,
        );
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
        this.rt.db
          .update(bookings)
          .set({ status: 'failed', callId: result.callId, notes: 'failed', updatedAt: at })
          .where(eq(bookings.id, booking.id))
          .run();
        await this.publish(plan.id, {
          type: 'doer_status',
          doer: 'caller',
          state: 'failed',
          detail: 'Call failed',
        });
        await this.fail(plan.id, 'call failed');
        return;
      }
      default:
        this.log.info({ planId: plan.id, outcome: result.outcome }, 'call result noted');
    }
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
    const spec = this.pollSpec(plan.id, t.payload);
    if (spec && !this.closedPolls.has(spec.pollId)) {
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
    const spec = this.pollSpec(planId);
    if (spec && !this.closedPolls.has(spec.pollId)) {
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
      const hard = (await this.deps.bubbles.getHardLimits(m.userId)).filter((f) => f.confirmed);
      const canRepresent = ['focus', 'sleep', 'driving'].includes(presence) && hard.length > 0;
      const user = await this.rt.crews.userById(m.userId);
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
    this.rt.plans.audit(planId, 'solver_run', {
      feasible: result.feasible.length,
      infeasible: result.infeasible.length,
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
      await this.rt.plans.transition(planId, 'DEADLOCK', { reason: 'no venue fits everyone' });
      await this.groupText(
        plan,
        'deadlock',
        'Nothing fits everyone yet. Checking privately whether something small can give.',
      );
      this.log.warn(
        { planId, infeasible: result.infeasible.length },
        'deadlock: Phase 3 breaker takes over',
      );
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
    const handle = await this.deps.caller.book({
      planId,
      bookingId,
      venue,
      backupVenue: backup,
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

  private async fail(planId: string, reason: string): Promise<void> {
    this.rt.timers.cancel(planId);
    const r = await this.rt.plans.tryTransition(planId, 'FAILED', { reason });
    if (!r.ok) return;
    await this.publish(planId, { type: 'plan_closed', reason: 'failed' });
    this.deps.intake?.closePlan(planId);
    await this.groupText(r.plan, 'failed', 'I could not get a table tonight. Sorry.');
  }

  // -- helpers -------------------------------------------------------------------

  private async solverMembers(
    plan: Plan,
    userIds: string[],
    represented: Set<string>,
  ): Promise<Array<SolverMember & { busy: Awaited<ReturnType<BubbleService['getFreeBusy']>> }>> {
    const spec = this.pollSpec(plan.id);
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
        location: await this.deps.bubbles.getLocation(userId),
        recentVenueIds: profile.recentVenueIds,
        recentCompromiseCount: profile.recentCompromiseCount,
        represented: represented.has(userId),
        busy,
      });
    }
    return out;
  }

  private ctx(plan: Plan, startMinutes: number): SolverContext {
    return {
      day: dayOfWeek(plan.intent.date),
      startMinutes,
      groupCenter: this.groupCenter(plan.groupId),
      meal: plan.intent.meal,
    };
  }

  private groupCenter(groupId: string) {
    return groupById(this.rt.db, groupId)?.center ?? null;
  }

  private pollSpec(planId: string, payload?: Record<string, unknown>): PollSpec | null {
    const cached = this.polls.get(planId);
    if (cached) return cached;
    const fromPayload =
      payload && typeof payload['pollId'] === 'string' ? (payload as unknown as PollSpec) : null;
    const fromTimer =
      fromPayload ??
      (this.rt.timers.pending(planId).find((t) => t.kind === 'poll_deadline')
        ?.payload as unknown as PollSpec | undefined);
    if (fromTimer && fromTimer.pollId) {
      this.polls.set(planId, fromTimer);
      return fromTimer;
    }
    return null;
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

  private async closePoll(plan: Plan, spec: PollSpec, leader: string | null): Promise<void> {
    this.closedPolls.add(spec.pollId);
    this.rt.plans.audit(plan.id, 'poll_closed', { pollId: spec.pollId, leader });
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
      text: `${r.organizerName} wants ${r.meal ?? 'food'} ${r.dayOffset === 1 ? 'tomorrow' : 'today'}. 👍 if you're in.`,
      idempotencyKey: idempotencyKey(r.planId, 'headcount'),
    });
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

  private async privateText(
    plan: Plan,
    userId: string,
    action: string,
    text: string,
  ): Promise<void> {
    await this.deps.messaging.sendPrivateText({
      userId,
      text,
      idempotencyKey: idempotencyKey(plan.id, action, userId),
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
