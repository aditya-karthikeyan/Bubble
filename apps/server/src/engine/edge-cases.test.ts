import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanEvent } from '@bubbleworks/shared';
import { FakeBubbles, FakeCaller, FakeDoers, FakeMessaging } from '@bubbleworks/shared/fakes';
import { loadConfig } from '../config.js';
import { bookings } from '../db/schema.js';
import { createRuntime, type Runtime } from '../runtime.js';
import { VENUES_FIXTURE } from '../test-helpers.js';
import { BubbleworksEngine } from './plan-engine.js';

const CHAT = 'crew:group_demo';
const DEADLINES = { poll_ms: 10_000, private_ask_ms: 5_000, veto_window_ms: 3_000, call_ms: 8_000 };

function harness(
  callerOpts: {
    scriptedOutcomes?: Array<
      | 'booked'
      | 'booked_backup'
      | 'declined'
      | 'no_answer'
      | 'needs_human'
      | 'modified'
      | 'cancelled'
      | 'failed'
    >;
  } = {},
) {
  let clock = Date.parse('2026-10-10T21:00:00.000Z');
  const now = () => new Date(clock);
  const rt: Runtime = createRuntime(loadConfig({ NODE_ENV: 'test', SEED_ON_BOOT: 'true' }), {
    dbPath: ':memory:',
    seed: true,
    venuesPath: VENUES_FIXTURE,
    timers: { deadlines: DEADLINES, now: () => clock },
  });
  const messaging = new FakeMessaging({ print: false });
  const bubbles = new FakeBubbles();
  const doers = new FakeDoers();
  const events: PlanEvent[] = [];
  rt.bus.subscribe('*', (e) => void events.push(e));
  const ref: { engine: BubbleworksEngine | null } = { engine: null };
  const caller = new FakeCaller((r) => ref.engine!.handleCallResult(r), {
    delayMs: 1,
    scriptedOutcomes: callerOpts.scriptedOutcomes,
  });
  const engine = new BubbleworksEngine({ runtime: rt, bubbles, messaging, caller, doers, now });
  ref.engine = engine;
  const advance = async (ms: number) => {
    clock += ms;
    await rt.timers.tick();
  };
  const settle = () => new Promise((r) => setTimeout(r, 15));
  const at = () => now().toISOString();
  /** Intent plus three in, Eli out, poll votes, lock. */
  async function toLocked() {
    const { planId } = await engine.handleIntent({
      chatId: CHAT,
      userId: 'user_ava',
      messageId: 'm1',
      text: 'dinner?',
      at: at(),
    });
    for (const u of ['user_ben', 'user_chloe', 'user_dev'])
      await engine.handleHeadcount({ planId: planId!, userId: u, in: true, at: at() });
    await engine.handleHeadcount({ planId: planId!, userId: 'user_eli', in: false, at: at() });
    if (rt.plans.get(planId!)?.state === 'GATHERING') await advance(DEADLINES.poll_ms + 1);
    expect(rt.plans.get(planId!)?.state).toBe('LOCKED');
    return planId!;
  }
  async function toBooked() {
    const planId = await toLocked();
    await advance(DEADLINES.veto_window_ms + 1);
    await settle();
    expect(rt.plans.get(planId)?.state).toBe('BOOKED');
    return planId;
  }
  return {
    rt,
    messaging,
    bubbles,
    doers,
    caller,
    engine,
    events,
    advance,
    settle,
    at,
    toLocked,
    toBooked,
  };
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.caller.dispose();
  h.rt.close();
});

describe('edge cases', () => {
  it('dropout before booking reruns the solver and keeps a lock', async () => {
    const planId = await h.toLocked();
    const first = h.rt.plans.get(planId)!;
    await h.engine.handleHeadcount({ planId, userId: 'user_dev', in: false, at: h.at() });
    const after = h.rt.plans.get(planId)!;
    expect(after.state).toBe('LOCKED');
    expect(h.rt.plans.inCount(planId)).toBe(3);
    expect(h.events.filter((e) => e.type === 'plan_locked').length).toBeGreaterThanOrEqual(2);
    expect(h.rt.timers.pending(planId).map((t) => t.kind)).toEqual(['veto_window']);
    expect(first.lockedAt).not.toBeNull();
  });

  it('dropout after booking keeps the venue, modifies the reservation, and redoes the split', async () => {
    h.caller.dispose();
    h.rt.close();
    h = harness({ scriptedOutcomes: ['booked', 'modified'] });
    const planId = await h.toBooked();
    const venueBefore = h.rt.plans.get(planId)!.chosenVenueId;
    await h.engine.handleHeadcount({ planId, userId: 'user_dev', in: false, at: h.at() });
    expect(h.caller.calls.map((c) => c.kind)).toEqual(['book', 'modify']);
    const modify = h.caller.calls[1];
    expect(modify && modify.kind === 'modify' ? modify.partySize : 0).toBe(3);
    await h.settle();
    const booking = h.rt.db.select().from(bookings).where(undefined).all()[0]!;
    expect(booking.partySize).toBe(3);
    expect(booking.status).toBe('booked');
    expect(h.rt.plans.get(planId)!.chosenVenueId).toBe(venueBefore);
    expect(h.doers.calls.filter((c) => c.doer === 'splitter')).toHaveLength(2);
    expect(h.rt.plans.get(planId)!.state).toBe('BOOKED');
  });

  it('late joiner before lock adds the bubble and reruns', async () => {
    const { planId } = await h.engine.handleIntent({
      chatId: CHAT,
      userId: 'user_ava',
      messageId: 'm1',
      text: 'dinner?',
      at: h.at(),
    });
    for (const u of ['user_ben', 'user_chloe'])
      await h.engine.handleHeadcount({ planId: planId!, userId: u, in: true, at: h.at() });
    for (const u of ['user_dev', 'user_eli'])
      await h.engine.handleHeadcount({ planId: planId!, userId: u, in: false, at: h.at() });
    if (h.rt.plans.get(planId!)?.state === 'GATHERING') await h.advance(DEADLINES.poll_ms + 1);
    expect(h.rt.plans.get(planId!)?.state).toBe('LOCKED');
    await h.engine.handleHeadcount({ planId: planId!, userId: 'user_dev', in: true, at: h.at() });
    expect(h.rt.plans.inCount(planId!)).toBe(4);
    expect(h.rt.plans.get(planId!)?.state).toBe('LOCKED');
    const locks = h.events.filter((e) => e.type === 'plan_locked');
    expect(locks.length).toBeGreaterThanOrEqual(2);
    expect(locks.at(-1) && locks.at(-1)!.type === 'plan_locked' ? locks.at(-1)!.partySize : 0).toBe(
      4,
    );
  });

  it('late joiner after booking asks the caller for a seat', async () => {
    h.caller.dispose();
    h.rt.close();
    h = harness({ scriptedOutcomes: ['booked', 'modified'] });
    const planId = await h.toBooked();
    await h.engine.handleHeadcount({ planId, userId: 'user_eli', in: true, at: h.at() });
    const modify = h.caller.calls.find((c) => c.kind === 'modify');
    expect(modify && modify.kind === 'modify' ? modify.partySize : 0).toBe(5);
    await h.settle();
    expect(h.rt.db.select().from(bookings).all()[0]!.partySize).toBe(5);
  });

  it('fewer than two left after booking cancels the reservation', async () => {
    h.caller.dispose();
    h.rt.close();
    h = harness({ scriptedOutcomes: ['booked', 'cancelled'] });
    const planId = await h.toBooked();
    for (const u of ['user_ben', 'user_chloe'])
      await h.engine.handleHeadcount({ planId, userId: u, in: false, at: h.at() });
    expect(h.rt.plans.get(planId)?.state).toBe('BOOKED');
    await h.engine.handleHeadcount({ planId, userId: 'user_dev', in: false, at: h.at() });
    expect(h.rt.plans.get(planId)?.state).toBe('CANCELLED');
    expect(h.caller.calls.map((c) => c.kind)).toContain('cancel');
    expect(h.events.some((e) => e.type === 'plan_closed' && e.reason === 'too_few')).toBe(true);
  });

  it('"actually tomorrow" from the organizer cancels the booking and starts over', async () => {
    h.caller.dispose();
    h.rt.close();
    h = harness({ scriptedOutcomes: ['booked', 'cancelled', 'booked'] });
    const planId = await h.toBooked();
    const r = await h.engine.handleIntent({
      chatId: CHAT,
      userId: 'user_ava',
      messageId: 'm2',
      text: 'actually dinner tomorrow instead',
      at: h.at(),
    });
    expect(r.created).toBe(true);
    expect(r.planId).not.toBe(planId);
    expect(h.rt.plans.get(planId)?.state).toBe('CANCELLED');
    expect(h.caller.calls.map((c) => c.kind)).toContain('cancel');
    const fresh = h.rt.plans.get(r.planId!)!;
    expect(fresh.state).toBe('GATHERING');
    expect(fresh.intent.date).toBe('2026-10-11');
    expect(h.rt.timers.pending(planId)).toEqual([]);
  });

  it('a different meal on the same chat is a second plan, a repeat is not', async () => {
    const a = await h.engine.handleIntent({
      chatId: CHAT,
      userId: 'user_ava',
      messageId: 'm1',
      text: 'dinner tonight?',
      at: h.at(),
    });
    const repeat = await h.engine.handleIntent({
      chatId: CHAT,
      userId: 'user_ben',
      messageId: 'm2',
      text: 'dinner??',
      at: h.at(),
    });
    expect(repeat).toEqual({ planId: a.planId, created: false });
    const b = await h.engine.handleIntent({
      chatId: CHAT,
      userId: 'user_ben',
      messageId: 'm3',
      text: 'brunch tomorrow?',
      at: h.at(),
    });
    expect(b.created).toBe(true);
    expect(b.planId).not.toBe(a.planId);
    expect(h.rt.plans.findActiveForChat(CHAT)).toHaveLength(2);
    // Headcounts route by plan id, so one plan's answers never touch the other.
    await h.engine.handleHeadcount({
      planId: b.planId!,
      userId: 'user_chloe',
      in: true,
      at: h.at(),
    });
    expect(h.rt.plans.members(a.planId!).find((m) => m.userId === 'user_chloe')?.status).toBe(
      'invited',
    );
    expect(h.rt.plans.members(b.planId!).find((m) => m.userId === 'user_chloe')?.status).toBe('in');
  });

  it('a deposit request waits for one person; yes books, no moves on', async () => {
    h.caller.dispose();
    h.rt.close();
    h = harness({ scriptedOutcomes: ['needs_human', 'booked'] });
    const planId = await h.toLocked();
    await h.advance(DEADLINES.veto_window_ms + 1);
    await h.settle();
    expect(h.rt.plans.get(planId)?.state).toBe('BOOKING');
    expect(h.rt.db.select().from(bookings).all()[0]!.status).toBe('needs_human');
    const pending = h.engine.pendingAskFor('user_ava');
    expect(pending).not.toBeNull();
    const privateTexts = h.messaging.sent.filter((s) => s.kind === 'private_text');
    expect(privateTexts).toHaveLength(1);
    expect('input' in privateTexts[0]! ? privateTexts[0].input.userId : '').toBe('user_ava');
    expect(h.events.some((e) => e.type === 'booking_confirmed')).toBe(false);

    await h.engine.handleAskAnswer({
      askId: pending!.askId,
      userId: 'user_ava',
      answer: 'no',
      rawText: 'no',
      at: h.at(),
    });
    // Declined: the venue is out, the solver reruns and locks another place.
    expect(h.rt.plans.get(planId)?.state).toBe('LOCKED');
    expect(
      h.events.some((e) => e.type === 'private_ask_resolved' && e.outcome === 'declined'),
    ).toBe(true);
  });

  it('a deposit approved by the organizer books under them', async () => {
    h.caller.dispose();
    h.rt.close();
    h = harness({ scriptedOutcomes: ['needs_human'] });
    const planId = await h.toLocked();
    await h.advance(DEADLINES.veto_window_ms + 1);
    await h.settle();
    const pending = h.engine.pendingAskFor('user_ava')!;
    await h.engine.handleAskAnswer({
      askId: pending.askId,
      userId: 'user_ava',
      answer: 'yes',
      rawText: 'yes',
      at: h.at(),
    });
    expect(h.rt.plans.get(planId)?.state).toBe('BOOKED');
    expect(h.events.some((e) => e.type === 'booking_confirmed')).toBe(true);
    expect(h.rt.db.select().from(bookings).all()[0]!.status).toBe('booked');
  });

  it('member leaves the crew during deliberation: dropped and rerun', async () => {
    const planId = await h.toLocked();
    await h.engine.handleMemberChange({
      chatId: CHAT,
      userId: 'user_ben',
      change: 'left',
      at: h.at(),
    });
    expect(h.rt.plans.members(planId).find((m) => m.userId === 'user_ben')?.status).toBe('dropped');
    expect(h.events.some((e) => e.type === 'bubble_left' && e.reason === 'left_group')).toBe(true);
    expect(h.rt.plans.get(planId)?.state).toBe('LOCKED');
    expect(h.rt.plans.inCount(planId)).toBe(3);
  });

  it('server restart mid-call: kick reschedules the call timeout and the timeout reruns', async () => {
    h.caller.dispose();
    h.rt.close();
    h = harness({ scriptedOutcomes: ['booked'] });
    const planId = await h.toLocked();
    await h.advance(DEADLINES.veto_window_ms + 1);
    expect(h.rt.plans.get(planId)?.state).toBe('BOOKING');
    // Simulate the crash: the in-flight fake call never delivers, and the timer table is what survives.
    h.caller.dispose();
    h.rt.timers.cancel(planId, 'call_timeout');
    expect(h.rt.timers.pending(planId)).toEqual([]);
    await h.engine.kick(planId);
    expect(h.rt.timers.pending(planId).map((t) => t.kind)).toEqual(['call_timeout']);
    await h.advance(DEADLINES.call_ms + 1);
    // No answer: the venue is removed and the solver locks the next one.
    const plan = h.rt.plans.get(planId)!;
    expect(['LOCKED', 'DEADLOCK', 'DELIBERATING']).toContain(plan.state);
    expect(
      h.events.some((e) => e.type === 'doer_status' && e.doer === 'caller' && e.state === 'failed'),
    ).toBe(true);
  });
});
