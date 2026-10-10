import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanEvent } from '@bubbleworks/shared';
import {
  FakeBubbles,
  FakeCaller,
  FakeDoers,
  FakeMessaging,
  PERSONA_FACTS,
} from '@bubbleworks/shared/fakes';
import { loadConfig } from '../config.js';
import { createRuntime, type Runtime } from '../runtime.js';
import { VENUES_FIXTURE } from '../test-helpers.js';
import { BubbleworksEngine } from './plan-engine.js';

const CHAT = 'crew:group_demo';
const DEADLINES = { poll_ms: 10_000, private_ask_ms: 5_000, veto_window_ms: 3_000, call_ms: 8_000 };

function harness(opts: { bubbles?: FakeBubbles } = {}) {
  let clock = Date.parse('2026-10-10T21:00:00.000Z'); // 17:00 New York, a Saturday
  const now = () => new Date(clock);
  const rt: Runtime = createRuntime(loadConfig({ NODE_ENV: 'test', SEED_ON_BOOT: 'true' }), {
    dbPath: ':memory:',
    seed: true,
    venuesPath: VENUES_FIXTURE,
    timers: { deadlines: DEADLINES, now: () => clock },
  });
  const messaging = new FakeMessaging({ print: false });
  const bubbles = opts.bubbles ?? new FakeBubbles();
  const doers = new FakeDoers();
  const events: PlanEvent[] = [];
  rt.bus.subscribe('*', (e) => void events.push(e));
  // Engine is created after the caller so the sink can reach it.
  const ref: { engine: BubbleworksEngine | null } = { engine: null };
  const caller = new FakeCaller((r) => ref.engine!.handleCallResult(r), { delayMs: 1 });
  const engine = new BubbleworksEngine({
    runtime: rt,
    bubbles,
    messaging,
    caller,
    doers,
    webPublicUrl: 'https://page.test',
    now,
  });
  ref.engine = engine;
  const advance = async (ms: number) => {
    clock += ms;
    await rt.timers.tick();
  };
  const settle = () => new Promise((r) => setTimeout(r, 15));
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
    now,
    at: () => now().toISOString(),
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

describe('BubbleworksEngine', () => {
  it('runs dinner tonight from intent to booked with the fakes', async () => {
    const r = await h.engine.handleIntent({
      chatId: CHAT,
      userId: 'user_ava',
      messageId: 'm1',
      text: 'dinner tonight?',
      at: h.at(),
    });
    expect(r.created).toBe(true);
    const planId = r.planId!;
    expect(h.rt.plans.get(planId)?.state).toBe('GATHERING');
    // Bundle went out: headcount text, a cuisine poll (preferences disagree), the page link.
    expect(h.messaging.sent.map((s) => s.kind)).toEqual(
      expect.arrayContaining(['group_text', 'poll', 'rich_link']),
    );
    const poll = h.messaging.sent.find((s) => s.kind === 'poll');
    expect(poll && 'input' in poll ? poll.input.chatId : null).toBe(CHAT);
    expect(h.rt.timers.pending(planId).map((t) => t.kind)).toEqual(['poll_deadline']);

    for (const u of ['user_ben', 'user_chloe', 'user_dev']) {
      await h.engine.handleHeadcount({ planId, userId: u, in: true, at: h.at() });
    }
    await h.engine.handleHeadcount({ planId, userId: 'user_eli', in: false, at: h.at() });
    expect(h.rt.plans.get(planId)?.state).toBe('GATHERING'); // poll still open

    const pollId = poll && 'input' in poll ? poll.input.pollId : '';
    const option = poll && 'input' in poll ? poll.input.options[0]!.key : '';
    for (const u of ['user_ava', 'user_ben', 'user_chloe', 'user_dev']) {
      await h.engine.handleVote({ planId, pollId, userId: u, choices: [option], at: h.at() });
    }
    // Everyone answered and the poll is decided: deliberation ran and locked without waiting.
    const locked = h.rt.plans.get(planId)!;
    expect(locked.state).toBe('LOCKED');
    expect(locked.chosenVenueId).not.toBeNull();
    expect(locked.startAt).not.toBeNull();
    expect(h.rt.timers.pending(planId).map((t) => t.kind)).toEqual(['veto_window']);
    const types = h.events.map((e) => e.type);
    for (const t of ['candidate_added', 'round_complete', 'bubble_merged', 'plan_locked'])
      expect(types).toContain(t);
    expect(h.messaging.sent.some((s) => s.kind === 'close_poll')).toBe(true);

    await h.advance(DEADLINES.veto_window_ms + 1);
    expect(h.rt.plans.get(planId)?.state).toBe('BOOKING');
    expect(h.caller.calls).toHaveLength(1);
    await h.settle();
    const booked = h.rt.plans.get(planId)!;
    expect(booked.state).toBe('BOOKED');
    expect(h.events.map((e) => e.type)).toContain('booking_confirmed');
    expect(h.doers.calls.map((c) => c.doer)).toEqual(['inviter', 'splitter', 'watcher']);
    expect(h.rt.timers.pending(planId)).toEqual([]);
    const bookedText = h.messaging.sent.find(
      (s) => s.kind === 'group_text' && 'input' in s && s.input.text.startsWith('Booked'),
    );
    expect(bookedText).toBeDefined();
  });

  it('closes the poll deadline with silent members represented or dropped', async () => {
    h.bubbles.setPresence('user_eli', 'focus'); // Eli has confirmed hard facts: represented
    h.bubbles.setPresence('user_dev', 'available'); // Dev ignored it: dropped
    const { planId } = await h.engine.handleIntent({
      chatId: CHAT,
      userId: 'user_ava',
      messageId: 'm1',
      text: 'pizza tonight',
      at: h.at(),
    });
    await h.engine.handleHeadcount({ planId: planId!, userId: 'user_ben', in: true, at: h.at() });
    await h.engine.handleHeadcount({ planId: planId!, userId: 'user_chloe', in: true, at: h.at() });
    await h.advance(DEADLINES.poll_ms + 1);
    const members = h.rt.plans.members(planId!);
    expect(members.find((m) => m.userId === 'user_eli')?.status).toBe('represented');
    expect(members.find((m) => m.userId === 'user_dev')?.status).toBe('dropped');
    expect(h.rt.plans.get(planId!)?.state).toBe('LOCKED');
    const bubbles = h.events.filter((e) => e.type === 'round_complete').at(-1);
    expect(
      bubbles && bubbles.type === 'round_complete'
        ? bubbles.bubbles.find((b) => b.userId === 'user_eli')?.status
        : null,
    ).toBe('represented');
    // Named cuisine: no poll was asked.
    expect(h.messaging.sent.some((s) => s.kind === 'poll')).toBe(false);
  });

  it('deadlocks when no venue fits and reruns after a veto', async () => {
    const broke = new FakeBubbles(
      undefined,
      PERSONA_FACTS.map((f) => (f.id === 'fact_chloe_budget' ? { ...f, value: '5' } : f)),
    );
    h.caller.dispose();
    h.rt.close();
    h = harness({ bubbles: broke });
    const { planId } = await h.engine.handleIntent({
      chatId: CHAT,
      userId: 'user_ava',
      messageId: 'm1',
      text: 'dinner?',
      at: h.at(),
    });
    await h.engine.handleHeadcount({ planId: planId!, userId: 'user_chloe', in: true, at: h.at() });
    for (const u of ['user_ben', 'user_dev', 'user_eli'])
      await h.engine.handleHeadcount({ planId: planId!, userId: u, in: false, at: h.at() });
    await h.advance(DEADLINES.poll_ms + 1);
    expect(h.rt.plans.get(planId!)?.state).toBe('DEADLOCK');
  });

  it('veto during the window eliminates the pick and locks another', async () => {
    const { planId } = await h.engine.handleIntent({
      chatId: CHAT,
      userId: 'user_ava',
      messageId: 'm1',
      text: 'dinner?',
      at: h.at(),
    });
    for (const u of ['user_ben', 'user_dev'])
      await h.engine.handleHeadcount({ planId: planId!, userId: u, in: true, at: h.at() });
    for (const u of ['user_chloe', 'user_eli'])
      await h.engine.handleHeadcount({ planId: planId!, userId: u, in: false, at: h.at() });
    await h.advance(DEADLINES.poll_ms + 1);
    const first = h.rt.plans.get(planId!)!;
    expect(first.state).toBe('LOCKED');
    await h.engine.handleCommand({
      chatId: CHAT,
      userId: 'user_ben',
      command: 'veto',
      messageId: 'm2',
      at: h.at(),
    });
    const second = h.rt.plans.get(planId!)!;
    expect(second.state).toBe('LOCKED');
    expect(second.chosenVenueId).not.toBe(first.chosenVenueId);
    expect(h.events.some((e) => e.type === 'candidate_eliminated' && e.reason === 'vetoed')).toBe(
      true,
    );
  });

  it('wait pauses and resume picks up; cancel closes; second intent in the same crew is ignored', async () => {
    const { planId } = await h.engine.handleIntent({
      chatId: CHAT,
      userId: 'user_ava',
      messageId: 'm1',
      text: 'dinner?',
      at: h.at(),
    });
    const again = await h.engine.handleIntent({
      chatId: CHAT,
      userId: 'user_ben',
      messageId: 'm2',
      text: 'dinner??',
      at: h.at(),
    });
    expect(again).toEqual({ planId, created: false });
    await h.engine.handleCommand({
      chatId: CHAT,
      userId: 'user_ava',
      command: 'wait',
      messageId: 'm3',
      at: h.at(),
    });
    expect(h.rt.plans.get(planId!)?.state).toBe('PAUSED');
    await h.advance(DEADLINES.poll_ms + 1); // deadline fires while paused: ignored
    expect(h.rt.plans.get(planId!)?.state).toBe('PAUSED');
    for (const u of ['user_ben', 'user_dev']) h.rt.plans.upsertMember(planId!, u, 'in');
    await h.engine.handleCommand({
      chatId: CHAT,
      userId: 'user_ava',
      command: 'resume',
      messageId: 'm4',
      at: h.at(),
    });
    expect(h.rt.plans.get(planId!)?.state).toBe('LOCKED'); // kick ran the overdue deadline
    await h.engine.handleCommand({
      chatId: CHAT,
      userId: 'user_ava',
      command: 'cancel',
      messageId: 'm5',
      at: h.at(),
    });
    expect(h.rt.plans.get(planId!)?.state).toBe('CANCELLED');
    expect(h.rt.timers.pending(planId!)).toEqual([]);
    expect(h.events.at(-1)?.type).toBe('plan_closed');
  });

  it('too few in closes the plan', async () => {
    const { planId } = await h.engine.handleIntent({
      chatId: CHAT,
      userId: 'user_ava',
      messageId: 'm1',
      text: 'dinner?',
      at: h.at(),
    });
    for (const u of ['user_ben', 'user_chloe', 'user_dev', 'user_eli'])
      await h.engine.handleHeadcount({ planId: planId!, userId: u, in: false, at: h.at() });
    expect(h.rt.plans.get(planId!)?.state).toBe('CLOSED');
    expect(h.events.some((e) => e.type === 'plan_closed' && e.reason === 'too_few')).toBe(true);
  });
});
