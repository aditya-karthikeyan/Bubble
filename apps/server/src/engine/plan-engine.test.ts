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
import { ledger } from '../db/schema.js';
import { createRuntime, type Runtime } from '../runtime.js';
import { VENUES_FIXTURE } from '../test-helpers.js';
import type { VenueSource } from '../venues/places.js';
import { BubbleworksEngine } from './plan-engine.js';

const CHAT = 'crew:group_demo';
const DEADLINES = { poll_ms: 10_000, private_ask_ms: 5_000, veto_window_ms: 3_000, call_ms: 8_000 };

function harness(
  opts: { bubbles?: FakeBubbles; flow?: 'polls' | 'agent_first'; venueSource?: VenueSource } = {},
) {
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
    ...(opts.flow ? { flow: opts.flow } : {}),
    ...(opts.venueSource ? { venueSource: opts.venueSource } : {}),
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

    // Vote in every poll the bundle asked (style first when present, then cuisine).
    for (const sent of h.messaging.sent.filter((x) => x.kind === 'poll')) {
      if (!('input' in sent)) continue;
      for (const u of ['user_ava', 'user_ben', 'user_chloe', 'user_dev']) {
        await h.engine.handleVote({
          planId,
          pollId: sent.input.pollId,
          userId: u,
          choices: [sent.input.options[0]!.key],
          at: h.at(),
        });
      }
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
    // No separate "Booked" text from the engine: the ticket and the invite carry it.
    expect(
      h.messaging.sent.some(
        (s) => s.kind === 'group_text' && 'input' in s && s.input.text.startsWith('Booked'),
      ),
    ).toBe(false);
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
    // Both pizza places are $2 over Chloe's budget: a small stretch keeps the pizza, so Chloe is
    // asked first (privately), before anyone is asked to change the cuisine.
    expect(h.rt.plans.get(planId!)?.state).toBe('DEADLOCK');
    await h.engine.handleAskAnswer({
      askId: h.engine.pendingAskFor('user_chloe')!.askId,
      userId: 'user_chloe',
      answer: 'yes',
      rawText: 'yes',
      at: h.at(),
    });
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
    // Named cuisine: no cuisine poll was asked (a style poll may still go out).
    const cuisinePolls = h.messaging.sent.filter(
      (x) =>
        x.kind === 'poll' && 'input' in x && !x.input.options.some((o) => o.key === 'sit_down'),
    );
    expect(cuisinePolls).toHaveLength(0);
  });

  describe('deadlock breaker', () => {
    const tight = (chloe: string, ava: string) =>
      new FakeBubbles(
        undefined,
        PERSONA_FACTS.map((f) =>
          f.id === 'fact_chloe_budget'
            ? { ...f, value: chloe }
            : f.id === 'fact_ava_budget'
              ? { ...f, value: ava }
              : f,
        ),
      );

    async function toDeadlock(bubbles: FakeBubbles) {
      h.caller.dispose();
      h.rt.close();
      h = harness({ bubbles });
      const { planId } = await h.engine.handleIntent({
        chatId: CHAT,
        userId: 'user_ava',
        messageId: 'm1',
        text: 'dinner?',
        at: h.at(),
      });
      await h.engine.handleHeadcount({
        planId: planId!,
        userId: 'user_chloe',
        in: true,
        at: h.at(),
      });
      for (const u of ['user_ben', 'user_dev', 'user_eli'])
        await h.engine.handleHeadcount({ planId: planId!, userId: u, in: false, at: h.at() });
      // With no feasible venue the policy skips the poll, so the plan deliberates as soon as
      // everyone has answered; only wait for the deadline when it is still gathering.
      if (h.rt.plans.get(planId!)?.state === 'GATHERING') await h.advance(DEADLINES.poll_ms + 1);
      return planId!;
    }

    it('sends a private ask to the one person who can give and locks on yes', async () => {
      // Chloe at $10 blocks every dinner venue (cheapest $12); Ava at $25 has nothing to give.
      const planId = await toDeadlock(tight('10', '25'));
      expect(h.rt.plans.get(planId)?.state).toBe('DEADLOCK');
      const asks = h.messaging.sent.filter((s) => s.kind === 'private_text');
      expect(asks).toHaveLength(1);
      const ask = asks[0]!;
      expect('input' in ask ? ask.input.userId : '').toBe('user_chloe');
      const text = 'input' in ask ? ask.input.text : '';
      expect(text).toContain('Chloe');
      expect(text).not.toContain('Ava');
      expect(text).toMatch(/yes or no/);
      expect(h.events.filter((e) => e.type === 'private_ask_sent')).toHaveLength(1);
      expect(h.rt.timers.pending(planId).map((t) => t.kind)).toEqual(['ask_timeout']);
      // The group only hears that something is being checked, nothing about who or what.
      const groupTexts = h.messaging.sent
        .filter((s) => s.kind === 'group_text')
        .map((s) => ('input' in s ? s.input.text : ''));
      expect(groupTexts.some((t) => /privately/.test(t))).toBe(true);
      expect(groupTexts.join(' ')).not.toMatch(/Chloe|\$1[05]|budget/);

      const pending = h.engine.pendingAskFor('user_chloe')!;
      await h.engine.handleAskAnswer({
        askId: pending.askId,
        userId: 'user_chloe',
        answer: 'yes',
        rawText: 'yes',
        at: h.at(),
      });
      expect(h.rt.plans.get(planId)?.state).toBe('LOCKED');
      const outcomes = h.events
        .filter((e) => e.type === 'private_ask_resolved')
        .map((e) => (e.type === 'private_ask_resolved' ? e.outcome : ''));
      expect(outcomes).toEqual(['accepted']);
      expect(h.engine.pendingAskFor('user_chloe')).toBeNull();
      expect(h.rt.timers.pending(planId).map((t) => t.kind)).toEqual(['veto_window']);
      // The compromise is on the ledger so fairness weighting sees it next time.
      expect(
        h.rt.db
          .select()
          .from(ledger)
          .all()
          .some((r) => r.userId === 'user_chloe' && r.kind === 'compromised'),
      ).toBe(true);
      for (const e of h.events) expect(JSON.stringify(e)).not.toMatch(/budget|\$1[05]/);
    });

    it('falls back on a decline: a time shift or a takeout close', async () => {
      const planId = await toDeadlock(tight('10', '25'));
      for (const u of ['user_chloe', 'user_ava']) {
        const pending = h.engine.pendingAskFor(u);
        if (pending)
          await h.engine.handleAskAnswer({
            askId: pending.askId,
            userId: u,
            answer: 'no',
            rawText: 'no',
            at: h.at(),
          });
      }
      const plan = h.rt.plans.get(planId)!;
      expect(plan.state).not.toBe('DEADLOCK');
      if (plan.state === 'CLOSED') {
        expect(h.events.some((e) => e.type === 'plan_closed' && e.reason === 'failed')).toBe(true);
        expect(
          h.messaging.sent.some(
            (s) => s.kind === 'group_text' && 'input' in s && /takeout/i.test(s.input.text),
          ),
        ).toBe(true);
      }
      expect(h.rt.timers.pending(planId).map((t) => t.kind)).not.toContain('ask_timeout');
    });

    it('expires unanswered asks and falls back', async () => {
      const planId = await toDeadlock(tight('10', '25'));
      await h.advance(DEADLINES.private_ask_ms + 1);
      const outcomes = h.events
        .filter((e) => e.type === 'private_ask_resolved')
        .map((e) => (e.type === 'private_ask_resolved' ? e.outcome : ''));
      expect(outcomes).toEqual(['expired']);
      expect(h.rt.plans.get(planId)?.state).not.toBe('DEADLOCK');
    });

    it('gives up without asking when two people would both have to stretch', async () => {
      // Both at $10: no single concession unlocks a venue, so nobody is asked and the plan falls back.
      const planId = await toDeadlock(tight('10', '10'));
      expect(h.messaging.sent.filter((s) => s.kind === 'private_text')).toHaveLength(0);
      expect(h.events.filter((e) => e.type === 'private_ask_sent')).toHaveLength(0);
      expect(h.rt.plans.get(planId)?.state).not.toBe('DEADLOCK');
    });
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

  it('asks sit-down vs fast food first and filters the solver by the answer', async () => {
    // Dev and Ben have no diet limits, so their feasible set spans burgers both ways.
    const crew = await h.rt.crews.createCrew({
      name: 'two',
      createdByUserId: 'user_dev',
      memberIds: ['user_ben'],
    });
    await h.rt.crews.confirmMember(crew.id, 'user_ben');
    const { planId } = await h.engine.handleIntent({
      chatId: crew.chatId,
      userId: 'user_dev',
      messageId: 'm1',
      text: 'dinner?',
      at: h.at(),
    });
    const polls = h.messaging.sent.filter((x) => x.kind === 'poll');
    const stylePoll = polls.find(
      (p) => 'input' in p && p.input.options.some((o) => o.key === 'fast_food'),
    );
    expect(stylePoll).toBeDefined();
    expect(polls[0]).toBe(stylePoll); // style is asked first
    await h.engine.handleHeadcount({ planId: planId!, userId: 'user_ben', in: true, at: h.at() });
    for (const sent of polls) {
      if (!('input' in sent)) continue;
      const choice = sent.input.options.some((o) => o.key === 'fast_food')
        ? 'fast_food'
        : sent.input.options[0]!.key;
      for (const u of ['user_dev', 'user_ben']) {
        await h.engine.handleVote({
          planId: planId!,
          pollId: sent.input.pollId,
          userId: u,
          choices: [choice],
          at: h.at(),
        });
      }
    }
    const plan = h.rt.plans.get(planId!)!;
    expect(plan.state).toBe('LOCKED');
    const winner = h.rt.venues().find((v) => v.id === plan.chosenVenueId)!;
    expect(winner.style).toBe('fast_food');
  });

  describe('voted cuisine out of range', () => {
    const VOTERS = ['user_ava', 'user_ben', 'user_chloe', 'user_dev'];
    /** The demo crew votes the first cuisine option, which then has nothing in range. */
    async function toCuisineAsk() {
      const { planId } = await h.engine.handleIntent({
        chatId: CHAT,
        userId: 'user_ava',
        messageId: 'm1',
        text: 'dinner tonight?',
        at: h.at(),
      });
      for (const u of ['user_ben', 'user_chloe', 'user_dev'])
        await h.engine.handleHeadcount({ planId: planId!, userId: u, in: true, at: h.at() });
      await h.engine.handleHeadcount({
        planId: planId!,
        userId: 'user_eli',
        in: false,
        at: h.at(),
      });
      const polls = h.messaging.sent.filter((x) => x.kind === 'poll');
      const cuisinePoll = polls.find(
        (p) => 'input' in p && !p.input.options.some((o) => o.key === 'fast_food'),
      );
      if (!cuisinePoll || !('input' in cuisinePoll)) throw new Error('no cuisine poll');
      // Vote for a cuisine other than American, so American places are left to switch to.
      const cuisine = cuisinePoll.input.options.find((o) => o.key !== 'american')!.key;
      // Every venue of that cuisine drops out before the vote ends (as a far location pin would).
      const all = h.rt.venues();
      for (let i = all.length - 1; i >= 0; i -= 1)
        if (all[i]!.cuisine === cuisine) all.splice(i, 1);
      h.messaging.sent.length = 0;
      for (const sent of polls) {
        if (!('input' in sent)) continue;
        const choice = sent === cuisinePoll ? cuisine : sent.input.options[0]!.key;
        for (const u of VOTERS) {
          await h.engine.handleVote({
            planId: planId!,
            pollId: sent.input.pollId,
            userId: u,
            choices: [choice],
            at: h.at(),
          });
        }
      }
      return { planId: planId!, cuisine };
    }
    const privateTexts = () =>
      h.messaging.sent
        .filter((s) => s.kind === 'private_text')
        .map((s) => ('input' in s ? [s.input.userId, s.input.text] : ['', '']));

    it('asks the voters before switching and locks the switch when they say yes', async () => {
      const { planId } = await toCuisineAsk();
      expect(h.rt.plans.get(planId)?.state).toBe('DEADLOCK');
      const texts = privateTexts();
      const asked = texts.filter(([, t]) => /OK to switch/.test(t!));
      // The poll decides once three of four agree; those three are asked, the fourth is told.
      const voters = asked.map(([u]) => u!);
      expect(voters.length).toBeGreaterThanOrEqual(3);
      for (const [, t] of asked)
        expect(t).toMatch(
          /won the vote, but no spot like that fits tonight\. OK to switch to .+\? Reply yes or no\.$/,
        );
      for (const [u, t] of texts)
        if (!voters.includes(u!)) expect(t).toMatch(/Checking with its voters about .+\.$/);
      expect(texts).toHaveLength(VOTERS.length);
      expect(h.rt.timers.pending(planId).map((t) => t.kind)).toEqual(['ask_timeout']);

      for (const u of voters) {
        // Each yes waits for the remaining voters.
        expect(h.rt.plans.get(planId)?.state).toBe('DEADLOCK');
        await h.engine.handleAskAnswer({
          askId: h.engine.pendingAskFor(u)!.askId,
          userId: u,
          answer: 'yes',
          rawText: 'yes',
          at: h.at(),
        });
      }
      expect(h.rt.plans.get(planId)?.state).toBe('LOCKED');
    });

    it('treats silence as yes', async () => {
      const { planId } = await toCuisineAsk();
      await h.advance(DEADLINES.private_ask_ms + 1);
      expect(h.rt.plans.get(planId)?.state).toBe('LOCKED');
    });

    it('keeps the cuisine when the voters say no, and never locks another cuisine', async () => {
      const { planId, cuisine } = await toCuisineAsk();
      const voters = VOTERS.filter((u) => h.engine.pendingAskFor(u));
      for (const u of voters) {
        await h.engine.handleAskAnswer({
          askId: h.engine.pendingAskFor(u)!.askId,
          userId: u,
          answer: 'no',
          rawText: 'no',
          at: h.at(),
        });
      }
      const plan = h.rt.plans.get(planId)!;
      expect(plan.state).not.toBe('LOCKED');
      if (plan.chosenVenueId)
        expect(h.rt.venues().find((v) => v.id === plan.chosenVenueId)?.cuisine).toBe(cuisine);
    });
  });

  describe('cuisine options come after the style vote', () => {
    /** Dev (vegan here) and Ben, with P2's staged intake: the cuisine poll waits for the style. */
    async function staged() {
      h.caller.dispose();
      h.rt.close();
      const veganDev = {
        ...PERSONA_FACTS[0]!,
        id: 'fact_dev_vegan',
        userId: 'user_dev',
        value: 'vegan',
      };
      h = harness({ bubbles: new FakeBubbles(undefined, [...PERSONA_FACTS, veganDev]) });
      const updates: Array<{ pollId: string; options: string[] | null }> = [];
      const seen: {
        request: {
          stylePoll: { pollId: string } | null;
          cuisinePoll: { pollId: string } | null;
        } | null;
      } = { request: null };
      h.engine.setIntake({
        renderBundle: async (r) => void (seen.request = r),
        closePlan: () => undefined,
        updatePoll: (_planId, pollId, options) => {
          updates.push({ pollId, options: options ? options.map((o) => o.key) : null });
          return true;
        },
      });
      const crew = await h.rt.crews.createCrew({
        name: 'two',
        createdByUserId: 'user_dev',
        memberIds: ['user_ben'],
      });
      await h.rt.crews.confirmMember(crew.id, 'user_ben');
      const { planId } = await h.engine.handleIntent({
        chatId: crew.chatId,
        userId: 'user_dev',
        messageId: 'm1',
        text: 'dinner?',
        at: h.at(),
      });
      await h.engine.handleHeadcount({ planId: planId!, userId: 'user_ben', in: true, at: h.at() });
      const r = seen.request;
      if (!r?.stylePoll || !r.cuisinePoll) throw new Error('expected style then cuisine');
      const vote = async (pollId: string, choice: string) => {
        for (const u of ['user_dev', 'user_ben'])
          await h.engine.handleVote({
            planId: planId!,
            pollId,
            userId: u,
            choices: [choice],
            at: h.at(),
          });
      };
      return {
        planId: planId!,
        style: r.stylePoll.pollId,
        cuisine: r.cuisinePoll.pollId,
        updates,
        vote,
      };
    }
    const venueOf = (planId: string) =>
      h.rt.venues().find((v) => v.id === h.rt.plans.get(planId)?.chosenVenueId);

    it('fast food with one vegan: only Chipotle fits, so no cuisine poll and Chipotle locks', async () => {
      const t = await staged();
      await t.vote(t.style, 'fast_food');
      expect(t.updates).toEqual([{ pollId: t.cuisine, options: null }]);
      expect(h.rt.plans.get(t.planId)?.state).toBe('LOCKED');
      expect(venueOf(t.planId)?.name).toBe('Chipotle');
    });

    it('fast food fits nobody: the group hears it and gets sit-down cuisines that fit', async () => {
      const t = await staged();
      const all = h.rt.venues();
      all.splice(
        all.findIndex((v) => v.name === 'Chipotle'),
        1,
      ); // out of range tonight
      await t.vote(t.style, 'fast_food');
      const texts = h.messaging.sent
        .filter((s) => s.kind === 'group_text')
        .map((s) => ('input' in s ? s.input.text : ''));
      expect(texts).toContain(
        'Nothing fast food works for everyone tonight, so here are sit-down options.',
      );
      const offered = t.updates.at(-1)!.options!;
      expect(offered.length).toBeGreaterThanOrEqual(2);
      for (const key of offered) {
        expect(
          h.rt
            .venues()
            .some(
              (v) => v.cuisine === key && v.style === 'sit_down' && v.dietTags.includes('vegan'),
            ),
        ).toBe(true);
      }
      expect(h.rt.plans.get(t.planId)?.state).toBe('GATHERING');
      await t.vote(t.cuisine, offered[0]!);
      expect(h.rt.plans.get(t.planId)?.state).toBe('LOCKED');
      const venue = venueOf(t.planId)!;
      expect([venue.cuisine, venue.style]).toEqual([offered[0], 'sit_down']);
      expect(venue.dietTags).toContain('vegan');
    });
  });

  it('a typed style skips the style poll', async () => {
    await h.engine.handleIntent({
      chatId: CHAT,
      userId: 'user_ava',
      messageId: 'm1',
      text: 'sit-down dinner tonight?',
      at: h.at(),
    });
    const polls = h.messaging.sent.filter((x) => x.kind === 'poll');
    expect(
      polls.every((p) => 'input' in p && !p.input.options.some((o) => o.key === 'sit_down')),
    ).toBe(true);
  });

  it('a poll vote from an undecided member counts as in', async () => {
    const { planId } = await h.engine.handleIntent({
      chatId: CHAT,
      userId: 'user_ava',
      messageId: 'm1',
      text: 'dinner?',
      at: h.at(),
    });
    const poll = h.messaging.sent.find((s) => s.kind === 'poll');
    const pollId = poll && 'input' in poll ? poll.input.pollId : '';
    const option = poll && 'input' in poll ? poll.input.options[0]!.key : '';
    await h.engine.handleVote({
      planId: planId!,
      pollId,
      userId: 'user_ben',
      choices: [option],
      at: h.at(),
    });
    expect(h.rt.plans.members(planId!).find((m) => m.userId === 'user_ben')?.status).toBe('in');
    expect(h.events.some((e) => e.type === 'bubble_joined' && e.bubble.userId === 'user_ben')).toBe(
      true,
    );
    // A cleared vote from someone already in does not change their status.
    await h.engine.handleVote({
      planId: planId!,
      pollId,
      userId: 'user_ben',
      choices: [],
      at: h.at(),
    });
    expect(h.rt.plans.members(planId!).find((m) => m.userId === 'user_ben')?.status).toBe('in');
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

  describe('a far-away live location', () => {
    it('plans from the group area instead of sinking the plan on distance', async () => {
      // Chloe's last fix is in Durham, farther than any venue can be stretched to.
      h.bubbles.setLocation('user_chloe', { lat: 35.994, lng: -78.8986 });
      const { planId } = await h.engine.handleIntent({
        chatId: CHAT,
        userId: 'user_ava',
        messageId: 'm1',
        text: 'dinner tonight?',
        at: h.at(),
      });
      for (const u of ['user_ben', 'user_chloe', 'user_dev'])
        await h.engine.handleHeadcount({ planId: planId!, userId: u, in: true, at: h.at() });
      await h.engine.handleHeadcount({
        planId: planId!,
        userId: 'user_eli',
        in: false,
        at: h.at(),
      });
      for (const sent of h.messaging.sent.filter((x) => x.kind === 'poll')) {
        if (!('input' in sent)) continue;
        for (const u of ['user_ava', 'user_ben', 'user_chloe', 'user_dev']) {
          await h.engine.handleVote({
            planId: planId!,
            pollId: sent.input.pollId,
            userId: u,
            choices: [sent.input.options[0]!.key],
            at: h.at(),
          });
        }
      }
      if (h.rt.plans.get(planId!)?.state === 'GATHERING') await h.advance(DEADLINES.poll_ms + 1);
      expect(h.rt.plans.get(planId!)?.state).toBe('LOCKED');
    });
  });

  describe('a named cuisine with nothing in range', () => {
    it('still lets the breaker ask the one person who can give', async () => {
      // Chloe at $10 blocks every venue, and the message names Thai, which no venue serves.
      h.caller.dispose();
      h.rt.close();
      h = harness({
        bubbles: new FakeBubbles(
          undefined,
          PERSONA_FACTS.map((f) =>
            f.id === 'fact_chloe_budget'
              ? { ...f, value: '10' }
              : f.id === 'fact_ava_budget'
                ? { ...f, value: '25' }
                : f,
          ),
        ),
      });
      const { planId } = await h.engine.handleIntent({
        chatId: CHAT,
        userId: 'user_ava',
        messageId: 'm1',
        text: 'thai dinner?',
        at: h.at(),
      });
      await h.engine.handleHeadcount({
        planId: planId!,
        userId: 'user_chloe',
        in: true,
        at: h.at(),
      });
      for (const u of ['user_ben', 'user_dev', 'user_eli'])
        await h.engine.handleHeadcount({ planId: planId!, userId: u, in: false, at: h.at() });
      if (h.rt.plans.get(planId!)?.state === 'GATHERING') await h.advance(DEADLINES.poll_ms + 1);
      // The cuisine cannot be bought back with money, so the breaker looks past it and asks
      // Chloe about her budget instead of closing the plan.
      expect(h.rt.plans.get(planId!)?.state).toBe('DEADLOCK');
      const asks = h.messaging.sent.filter((s) => s.kind === 'private_text');
      expect(asks).toHaveLength(1);
      expect('input' in asks[0]! ? asks[0]!.input.userId : '').toBe('user_chloe');
      expect(h.rt.timers.pending(planId!).map((t) => t.kind)).toEqual(['ask_timeout']);
    });
  });

  describe('agent-first flow', () => {
    const start = (text: string, extra: Parameters<typeof harness>[0] = {}) => {
      h.caller.dispose();
      h.rt.close();
      h = harness({ flow: 'agent_first', ...extra });
      return () =>
        h.engine.handleIntent({
          chatId: CHAT,
          userId: 'user_ava',
          messageId: 'm1',
          text,
          at: h.at(),
        });
    };
    const statuses = (planId: string) =>
      Object.fromEntries(h.rt.plans.members(planId).map((m) => [m.userId, m.status]));
    const privateTexts = () => h.messaging.sent.filter((s) => s.kind === 'private_text');

    it('books a live place from one message: no polls, nobody taps, nobody is asked', async () => {
      const live: VenueSource = {
        search: async (q) => [
          {
            id: 'venue_gp_live1',
            name: 'Lantern',
            cuisine: q.cuisine ?? 'other',
            style: 'sit_down',
            dietTags: ['vegetarian', 'halal'],
            accessibilityTags: [],
            priceLevel: 2,
            typicalCostUsd: 18,
            hours: Array.from({ length: 7 }, () => [{ open: 660, close: 1320 }]),
            phone: '+19195550199',
            location: { lat: 35.9132, lng: -79.0558 },
            address: null,
            neighborhood: null,
            isDemo: false,
          },
        ],
      };
      const intent = start('hey i want to do a dinner w my group and we r feeling italian', {
        venueSource: live,
      });
      h.bubbles.setPresence('user_eli', 'sleep');
      const { planId } = await intent();
      expect(h.messaging.sent.filter((s) => s.kind === 'poll')).toHaveLength(0);
      const head = h.messaging.sent.find((s) => s.kind === 'group_text');
      const text = head && 'input' in head ? head.input.text : '';
      expect(text).toContain('Italian dinner');
      expect(text).toContain('counted in');
      expect(h.rt.venues().some((v) => v.id === 'venue_gp_live1')).toBe(true);

      // Nobody answers. At the deadline the awake members count as in; Eli is asleep.
      await h.advance(DEADLINES.poll_ms + 1);
      const plan = h.rt.plans.get(planId!)!;
      expect(plan.state).toBe('LOCKED');
      expect(plan.chosenVenueId).toBe('venue_gp_live1');
      expect(privateTexts()).toHaveLength(0);
      const st = statuses(planId!);
      expect(st['user_ben']).toBe('in');
      expect(st['user_chloe']).toBe('in');
      expect(['represented', 'dropped']).toContain(st['user_eli']);

      await h.advance(DEADLINES.veto_window_ms + 1);
      await h.settle();
      expect(h.rt.plans.get(planId!)?.state).toBe('BOOKED');
    });

    it('asks the one person to stretch before changing the cuisine', async () => {
      // The only stored Indian place is $22 and Chloe's budget is $20.
      const intent = start('dinner with the group tonight, feeling indian');
      const { planId } = await intent();
      await h.advance(DEADLINES.poll_ms + 1);
      expect(h.rt.plans.get(planId!)?.state).toBe('DEADLOCK');
      const asks = privateTexts();
      expect(asks).toHaveLength(1);
      expect('input' in asks[0]! ? asks[0]!.input.userId : '').toBe('user_chloe');
      expect('input' in asks[0]! ? asks[0]!.input.text : '').not.toContain('won the vote');
      await h.engine.handleAskAnswer({
        askId: h.engine.pendingAskFor('user_chloe')!.askId,
        userId: 'user_chloe',
        answer: 'yes',
        rawText: 'yes',
        at: h.at(),
      });
      const plan = h.rt.plans.get(planId!)!;
      expect(plan.state).toBe('LOCKED');
      expect(h.rt.venues().find((v) => v.id === plan.chosenVenueId)?.cuisine).toBe('indian');
    });

    it('still honors "out"', async () => {
      const intent = start('dinner with the group tonight, feeling indian');
      const { planId } = await intent();
      for (const u of ['user_ben', 'user_chloe'])
        await h.engine.handleHeadcount({ planId: planId!, userId: u, in: false, at: h.at() });
      await h.advance(DEADLINES.poll_ms + 1);
      // Ava, Dev, and Eli all fit the Indian place, so no one is asked anything.
      expect(h.rt.plans.get(planId!)?.state).toBe('LOCKED');
      expect(privateTexts()).toHaveLength(0);
      const st = statuses(planId!);
      expect(st['user_ben']).toBe('out');
      expect(st['user_chloe']).toBe('out');
      expect(st['user_dev']).toBe('in');
    });
  });
});
