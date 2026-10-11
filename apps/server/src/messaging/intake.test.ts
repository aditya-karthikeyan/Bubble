import Database from 'better-sqlite3';
import type {
  AskAnswerInput,
  CallResult,
  CommandInput,
  HeadcountInput,
  IntentInput,
  IntentResult,
  MemberChangeInput,
  PlanEngine,
  VoteInput,
} from '@bubbleworks/shared';
import { DEMO_GROUP, FakeCrewDirectory, PERSONAS } from '@bubbleworks/shared/fakes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../events/bus.js';
import { SpectrumMessaging } from './adapter.js';
import { BundleStore, clockTime, headcountText, type QuestionDecision } from './bundle.js';
import { StubClassifier } from './classifier.js';
import { FakeTransport } from './fake-transport.js';
import { PlanIntake } from './intake.js';
import { AuditLog } from './safety.js';
import { MessagingStore } from './store.js';

const [AVA, BEN, CHLOE] = PERSONAS as [
  (typeof PERSONAS)[0],
  (typeof PERSONAS)[0],
  (typeof PERSONAS)[0],
];
const CREW = DEMO_GROUP.chatId;
const at = '2026-10-10T22:00:00.000Z';

/** Records engine calls; handleIntent opens plan_1 and renders a bundle like P1's policy will. */
class RecordingEngine implements PlanEngine {
  intents: IntentInput[] = [];
  headcounts: HeadcountInput[] = [];
  votes: VoteInput[] = [];
  intake: PlanIntake | null = null;

  async handleIntent(input: IntentInput): Promise<IntentResult> {
    this.intents.push(input);
    const decision: QuestionDecision = {
      planId: 'plan_1',
      chatId: input.chatId,
      organizerName: 'Ava',
      meal: 'dinner',
      cuisinePoll: {
        pollId: 'poll_cuisine',
        options: [
          { key: 'thai', label: 'Thai' },
          { key: 'pizza', label: 'Pizza' },
        ],
      },
      headcount: { closesAt: '2026-10-10T23:05:00.000Z', timezone: 'America/New_York' },
      pageUrl: 'https://bubbleworks.example/p/token',
    };
    await this.intake!.renderBundle(decision);
    return { planId: 'plan_1', created: true };
  }
  async handleVote(input: VoteInput): Promise<void> {
    this.votes.push(input);
  }
  async handleHeadcount(input: HeadcountInput): Promise<void> {
    this.headcounts.push(input);
  }
  async handleAskAnswer(_input: AskAnswerInput): Promise<void> {}
  async handleMemberChange(_input: MemberChangeInput): Promise<void> {}
  async handleCallResult(_result: CallResult): Promise<void> {}
  commands: CommandInput[] = [];
  async handleCommand(input: CommandInput): Promise<void> {
    this.commands.push(input);
  }
}

async function setup(classifier = new StubClassifier()) {
  const transport = new FakeTransport('imessage');
  const sqlite = new Database(':memory:');
  const bundles = new BundleStore(sqlite);
  const crews = new FakeCrewDirectory();
  const port = new SpectrumMessaging({
    transport,
    crews,
    store: new MessagingStore(sqlite),
    log: silentLogger,
    debounceMs: 0,
    retry: { attempts: 1, baseDelayMs: 0 },
    openPlanCrew: async () => (bundles.openForChat(CREW) ? DEMO_GROUP.id : null),
  });
  const engine = new RecordingEngine();
  const audit = new AuditLog(sqlite);
  const intake = new PlanIntake({ port, engine, bundles, classifier, log: silentLogger, audit });
  engine.intake = intake;
  intake.start();
  await port.start();
  const text = (phone: string, body: string, id: string) =>
    port.handleInbound({ kind: 'text', providerId: id, phone, text: body, at });
  return { transport, bundles, port, engine, intake, classifier, text, audit };
}

describe('bundle text', () => {
  it('formats the headcount line with the closing time in the crew timezone', () => {
    expect(clockTime('2026-10-10T23:05:00.000Z', 'America/New_York')).toBe('7:05');
    expect(
      headcountText({
        planId: 'p',
        chatId: CREW,
        organizerName: 'Pranav',
        meal: 'dinner',
        cuisinePoll: null,
        headcount: { closesAt: '2026-10-10T23:05:00.000Z', timezone: 'America/New_York' },
        pageUrl: null,
      }),
    ).toBe(
      "Pranav is planning dinner tonight. Tap 👍 on this message if you're in. Voting closes 7:05.",
    );
  });
});

describe('PlanIntake', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows typing before batching, then sends headcount, poll, and link to every member', async () => {
    const { transport, engine, text } = await setup();
    await text(AVA.handle, 'dinner today?', 'in_1');
    await vi.runAllTimersAsync();
    // Typing went to Ava's DM before anything was sent.
    const typingOn = transport.calls.findIndex(
      (c) => c.op === 'typing' && c.on && c.chatId === `any;-;${AVA.handle}`,
    );
    expect(typingOn).toBeGreaterThanOrEqual(0);
    expect(typingOn).toBeLessThan(transport.calls.findIndex((c) => c.op === 'send'));

    expect(engine.intents).toEqual([
      { chatId: CREW, userId: AVA.id, messageId: 'in_1', text: 'dinner today?', at },
    ]);
    const sends = transport.sends();
    expect(sends).toHaveLength(PERSONAS.length * 3);
    const toBen = sends
      .filter((s) => s.chatId === `any;-;${BEN.handle}`)
      .map((s) => s.content.kind);
    expect(toBen).toEqual(['text', 'poll', 'link']);
    expect(transport.calls.at(-1)).toEqual({
      op: 'typing',
      chatId: `any;-;${AVA.handle}`,
      on: false,
    });
  });

  it('turns a 👍 on any member copy of the headcount into handleHeadcount(in)', async () => {
    const { transport, engine, port, text } = await setup();
    await text(AVA.handle, 'dinner today?', 'in_1');
    await vi.runAllTimersAsync();
    const bensHeadcount = transport.sends().find((s) => s.chatId === `any;-;${BEN.handle}`)!;
    await port.handleInbound({
      kind: 'reaction',
      providerId: 'rx',
      phone: BEN.handle,
      targetMessageId: bensHeadcount.messageId,
      emoji: '👍',
      removed: false,
      at,
    });
    expect(engine.headcounts).toEqual([{ planId: 'plan_1', userId: BEN.id, in: true, at }]);
  });

  it('parses RSVP replies with rules and asks Haiku only when unclear', async () => {
    const classifier = new StubClassifier({
      rsvp: { 'should be able to make it after 8': { stance: 'in', confidence: 0.9 } },
    });
    const { engine, text } = await setup(classifier);
    await text(AVA.handle, 'dinner today?', 'in_1');
    await vi.runAllTimersAsync();
    await text(BEN.handle, "can't tonight", 'in_2');
    await text(CHLOE.handle, 'should be able to make it after 8', 'in_3');
    await vi.runAllTimersAsync();
    expect(engine.headcounts.map((h) => [h.userId, h.in])).toEqual([
      [BEN.id, false],
      [CHLOE.id, true],
    ]);
    expect(classifier.calls).toEqual([{ kind: 'rsvp', text: 'should be able to make it after 8' }]);
  });

  it('forwards poll votes to handleVote with the plan id', async () => {
    const { transport, engine, port, text } = await setup();
    await text(AVA.handle, 'dinner today?', 'in_1');
    await vi.runAllTimersAsync();
    const bensPoll = transport
      .sends()
      .find((s) => s.chatId === `any;-;${BEN.handle}` && s.content.kind === 'poll')!;
    await port.handleInbound({
      kind: 'poll_vote',
      providerId: `${bensPoll.messageId}:1`,
      phone: BEN.handle,
      pollMessageId: bensPoll.messageId,
      optionLabel: 'Thai',
      selected: true,
      at,
    });
    expect(engine.votes).toEqual([
      { planId: 'plan_1', pollId: 'poll_cuisine', userId: BEN.id, choices: ['thai'], at },
    ]);
  });

  it('asks Haiku about weak detections and starts nothing when it says no', async () => {
    const classifier = new StubClassifier({
      intent: {
        'so hungry': {
          isPlanIntent: false,
          mealType: 'unknown',
          dateISO: '2026-10-10',
          timeHint: '',
          confidence: 0.9,
        },
      },
    });
    const { engine, transport, text } = await setup(classifier);
    await text(AVA.handle, 'so hungry', 'in_1');
    await vi.runAllTimersAsync();
    expect(classifier.calls).toEqual([{ kind: 'intent', text: 'so hungry' }]);
    expect(engine.intents).toHaveLength(0);
    expect(transport.sends()).toHaveLength(0);
  });

  it('falls back to rules when Haiku is unavailable', async () => {
    const { engine, text } = await setup(new StubClassifier());
    await text(AVA.handle, 'grab food later?', 'in_1');
    await vi.runAllTimersAsync();
    expect(engine.intents).toHaveLength(1);
  });

  it('leaves small talk alone', async () => {
    const { engine, transport, text } = await setup();
    await text(AVA.handle, 'how was the midterm', 'in_1');
    await vi.runAllTimersAsync();
    expect(engine.intents).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it('routes wait and why-this-place during an open plan to the engine, and audits the pause', async () => {
    const { engine, audit, text } = await setup();
    await text(AVA.handle, 'dinner today?', 'in_1');
    await vi.runAllTimersAsync();
    await text(BEN.handle, 'wait', 'in_2');
    await text(CHLOE.handle, 'why this place?', 'in_3');
    await vi.runAllTimersAsync();
    expect(engine.commands.map((c) => [c.userId, c.command, c.planId, c.chatId])).toEqual([
      [BEN.id, 'wait', 'plan_1', CREW],
      [CHLOE.id, 'why', 'plan_1', CREW],
    ]);
    expect(engine.headcounts).toHaveLength(0);
    expect(audit.list().map((e) => [e.userId, e.kind])).toEqual([[BEN.id, 'pause']]);
  });
});
