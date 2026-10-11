import Database from 'better-sqlite3';
import type {
  AskAnswerInput,
  Group,
  InboundPrivateMessage,
  CallResult,
  CommandInput,
  HeadcountInput,
  IntentInput,
  IntentResult,
  MemberChangeInput,
  PlanEngine,
  VoteInput,
} from '@bubbleworks/shared';
import { DEMO_GROUP, DEMO_MEMBERS, FakeCrewDirectory, PERSONAS } from '@bubbleworks/shared/fakes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger, type Logger } from '../events/bus.js';
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

/** A second crew for Ava and Ben: "the boys". */
const BOYS: Group = {
  ...DEMO_GROUP,
  id: 'group_boys',
  name: 'the boys',
  chatId: 'crew:group_boys',
};
const twoCrews = () =>
  new FakeCrewDirectory(PERSONAS, [
    { group: DEMO_GROUP, members: DEMO_MEMBERS },
    {
      group: BOYS,
      members: [AVA, BEN].map((u) => ({
        groupId: BOYS.id,
        userId: u.id,
        joinedAt: at,
        confirmedAt: at,
      })),
    },
  ]);

async function setup(
  classifier = new StubClassifier(),
  isOnboarded?: (userId: string) => boolean,
  log: Logger = silentLogger,
  /** Gives the intake a crew directory, so it asks which crew. */
  directory?: FakeCrewDirectory,
  claimsDm?: (userId: string, text: string) => boolean,
) {
  const transport = new FakeTransport('imessage');
  const sqlite = new Database(':memory:');
  const bundles = new BundleStore(sqlite);
  const crews = directory ?? new FakeCrewDirectory();
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
  const intake = new PlanIntake({
    port,
    engine,
    bundles,
    classifier,
    log,
    audit,
    ...(isOnboarded ? { isOnboarded } : {}),
    ...(directory ? { crews: directory } : {}),
    ...(claimsDm ? { claimsDm } : {}),
  });
  engine.intake = intake;
  port.setPendingAnswer((userId) => intake.pendingAnswer(userId));
  intake.start();
  const privates: InboundPrivateMessage[] = [];
  port.onPrivateMessage(async (m) => {
    privates.push(m);
  });
  await port.start();
  const text = async (phone: string, body: string, id: string) => {
    await port.handleInbound({ kind: 'text', providerId: id, phone, text: body, at });
    await vi.runAllTimersAsync();
  };
  /** Private texts the bubble sent this person, in order. */
  const dmsTo = (phone: string) =>
    transport
      .sends()
      .filter((s) => s.chatId === `any;-;${phone}` && s.content.kind === 'text')
      .map((s) => (s.content as { text: string }).text);
  return { transport, bundles, port, engine, intake, classifier, text, audit, privates, dmsTo };
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
    ).toMatch(
      /^🫧 Pranav's on dinner tonight\. Tap 👍 on this message if you're in\. Locking a spot at \d+:\d\d\.$/,
    );
  });
});

describe('PlanIntake', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stages the bundle: headcount first, poll once two are in', async () => {
    const { transport, engine, port, text } = await setup();
    await text(AVA.handle, 'thai dinner today?', 'in_1');
    await vi.runAllTimersAsync();
    // Typing went to Ava's DM before anything was sent.
    const typingOn = transport.calls.findIndex(
      (c) => c.op === 'typing' && c.on && c.chatId === `any;-;${AVA.handle}`,
    );
    expect(typingOn).toBeGreaterThanOrEqual(0);
    expect(typingOn).toBeLessThan(transport.calls.findIndex((c) => c.op === 'send'));
    expect(engine.intents).toEqual([
      { chatId: CREW, userId: AVA.id, messageId: 'in_1', text: 'thai dinner today?', at },
    ]);

    // Stage 1: only the headcount line. Ava (the organizer) already counts as in.
    expect(transport.sends().map((s) => s.content.kind)).toEqual(PERSONAS.map(() => 'text'));

    // Stage 2: Ben's 👍 makes two, so the poll goes out to everyone.
    const bensHeadcount = transport.sends().find((s) => s.chatId === `any;-;${BEN.handle}`)!;
    await port.handleInbound({
      kind: 'reaction',
      providerId: 'rx_ben',
      phone: BEN.handle,
      targetMessageId: bensHeadcount.messageId,
      emoji: '👍',
      removed: false,
      at,
    });
    const polls = transport.sends().filter((s) => s.content.kind === 'poll');
    expect(polls).toHaveLength(PERSONAS.length);
    // A third yes does not resend it.
    await text(CHLOE.handle, "I'm in", 'in_2');
    await vi.runAllTimersAsync();
    expect(transport.sends().filter((s) => s.content.kind === 'poll')).toHaveLength(
      PERSONAS.length,
    );
    // The link waits for deliberation (LiveSurfaces).
    expect(transport.sends().some((s) => s.content.kind === 'link')).toBe(false);
  });

  it('turns a 👍 on any member copy of the headcount into handleHeadcount(in)', async () => {
    const { transport, engine, port, text } = await setup();
    await text(AVA.handle, 'thai dinner today?', 'in_1');
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

  it('logs a headcount when it arrives, before the engine call that may lock the plan', async () => {
    // Two taps a second apart: the second one answers for the last person, so its engine call
    // deliberates and locks. Its log line must still sit before the lock, not after it.
    const order: string[] = [];
    const log: Logger = {
      ...silentLogger,
      info: (obj, msg) => {
        if (msg === 'headcount') order.push(`log ${String(obj['userId'])}`);
      },
    };
    const { transport, engine, port, text } = await setup(new StubClassifier(), undefined, log);
    engine.handleHeadcount = async (input) => {
      engine.headcounts.push(input);
      order.push(`engine ${input.userId}`);
    };
    await text(AVA.handle, 'thai dinner today?', 'in_1');
    await vi.runAllTimersAsync();
    for (const who of [BEN, CHLOE]) {
      const copy = transport.sends().find((s) => s.chatId === `any;-;${who.handle}`)!;
      await port.handleInbound({
        kind: 'reaction',
        providerId: `rx_${who.id}`,
        phone: who.handle,
        targetMessageId: copy.messageId,
        emoji: '👍',
        removed: false,
        at,
      });
    }
    await text(PERSONAS[3]!.handle, "I'm in", 'in_2');
    await vi.runAllTimersAsync();
    const dev = PERSONAS[3]!.id;
    expect(order).toEqual([
      `log ${BEN.id}`,
      `engine ${BEN.id}`,
      `log ${CHLOE.id}`,
      `engine ${CHLOE.id}`,
      `log ${dev}`,
      `engine ${dev}`,
    ]);
  });

  it('parses RSVP replies with rules and asks Haiku only when unclear', async () => {
    const classifier = new StubClassifier({
      rsvp: { 'should be able to make it after 8': { stance: 'in', confidence: 0.9 } },
    });
    const { engine, text } = await setup(classifier);
    await text(AVA.handle, 'thai dinner today?', 'in_1');
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
    await text(AVA.handle, 'thai dinner today?', 'in_1');
    await vi.runAllTimersAsync();
    await text(BEN.handle, "I'm in", 'in_ben');
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
    const { engine, transport, text, privates } = await setup(classifier);
    await text(AVA.handle, 'so hungry', 'in_1');
    await vi.runAllTimersAsync();
    expect(classifier.calls).toEqual([{ kind: 'intent', text: 'so hungry' }]);
    expect(engine.intents).toHaveLength(0);
    expect(transport.sends()).toHaveLength(0);
    // Not dropped: it goes on to the bubble, which answers it.
    expect(privates.map((p) => p.text)).toEqual(['so hungry']);
  });

  it('falls back to rules when Haiku is unavailable', async () => {
    const { engine, text } = await setup(new StubClassifier());
    await text(AVA.handle, 'grab tacos later?', 'in_1');
    await vi.runAllTimersAsync();
    expect(engine.intents).toHaveLength(1);
  });

  it('shows no typing for an onboarding answer that names food', async () => {
    const { transport, engine, text } = await setup(new StubClassifier(), () => false);
    await text(AVA.handle, 'chipotle and dinner at cava', 'in_1');
    await vi.runAllTimersAsync();
    expect(transport.calls.some((c) => c.op === 'typing')).toBe(false);
    expect(engine.intents).toHaveLength(0);
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
    await text(AVA.handle, 'thai dinner today?', 'in_1');
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

  it('never counts a question as an RSVP and answers status questions through the engine', async () => {
    const classifier = new StubClassifier({
      rsvp: { 'what are we eating': { stance: 'in', confidence: 0.95 } },
    });
    const { engine, text } = await setup(classifier);
    await text(AVA.handle, 'thai dinner today?', 'in_1');
    await vi.runAllTimersAsync();
    await text(BEN.handle, 'what are we eating', 'in_2');
    await text(CHLOE.handle, 'is it far', 'in_3');
    await vi.runAllTimersAsync();
    expect(engine.headcounts).toHaveLength(0);
    expect(engine.commands.map((c) => [c.userId, c.command])).toEqual([[BEN.id, 'why']]);
    expect(classifier.calls.map((c) => c.text)).not.toContain('what are we eating');
  });
});

describe('PlanIntake plan draft', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const CREWS_AND_CUISINE = /^Yeah fasho 🫧 Which crew, and what are we feeling\? You're in: /;
  const CUISINE_ONLY = 'Fasho 🫧 What are we feeling? (indian, chinese, mexican… or say anything)';

  it('asks which crew and what we are feeling in one question, then starts the plan', async () => {
    const { engine, text, dmsTo } = await setup(
      new StubClassifier(),
      undefined,
      silentLogger,
      twoCrews(),
    );
    await text(AVA.handle, 'i want to eat food w my friends', 'in_1');
    expect(engine.intents).toHaveLength(0);
    expect(dmsTo(AVA.handle)).toEqual([
      "Yeah fasho 🫧 Which crew, and what are we feeling? You're in: the usual suspects, the boys. " +
        'Or say "new crew <name>" to make one. (like: the usual suspects, indian)',
    ]);

    await text(AVA.handle, 'the boys, indian', 'in_2');
    expect(engine.intents).toHaveLength(1);
    expect(engine.intents[0]).toMatchObject({ chatId: BOYS.chatId, userId: AVA.id });
    expect(engine.intents[0]!.text).toContain('indian');
    expect(engine.intents[0]!.text).toContain('i want to eat food w my friends');
  });

  it('asks a one-crew member which crew when the message does not name it', async () => {
    const { engine, text, dmsTo } = await setup(
      new StubClassifier(),
      undefined,
      silentLogger,
      new FakeCrewDirectory(),
    );
    await text(AVA.handle, 'dinner tonight?', 'in_1');
    expect(dmsTo(AVA.handle)).toHaveLength(1);
    expect(dmsTo(AVA.handle)[0]).toMatch(CREWS_AND_CUISINE);
    expect(dmsTo(AVA.handle)[0]).toContain("You're in: the usual suspects.");
    expect(dmsTo(AVA.handle)[0]).toContain('new crew <name>');

    await text(AVA.handle, '1, thai', 'in_2');
    expect(engine.intents.map((i) => [i.chatId, i.text])).toEqual([
      [CREW, 'dinner tonight? feeling thai'],
    ]);
  });

  it('asks only the cuisine when the crew is named; "anything" keeps the original text', async () => {
    const { engine, text, dmsTo } = await setup(
      new StubClassifier(),
      undefined,
      silentLogger,
      new FakeCrewDirectory(),
    );
    await text(AVA.handle, 'dinner with the usual suspects tonight?', 'in_1');
    expect(dmsTo(AVA.handle)).toEqual([CUISINE_ONLY]);
    await text(AVA.handle, 'anything', 'in_2');
    expect(engine.intents.map((i) => [i.chatId, i.text])).toEqual([
      [CREW, 'dinner with the usual suspects tonight?'],
    ]);
  });

  it('re-asks once for what is still missing, then takes the only crew', async () => {
    const { engine, text, dmsTo } = await setup(
      new StubClassifier(),
      undefined,
      silentLogger,
      new FakeCrewDirectory(),
    );
    await text(AVA.handle, 'dinner tonight?', 'in_1');
    await text(AVA.handle, 'idk', 'in_2');
    // "idk" settles the cuisine; the crew is asked once more on its own.
    expect(dmsTo(AVA.handle)[1]).toBe('Which crew? 1) the usual suspects  Or "new crew <name>".');
    await text(AVA.handle, 'whatever', 'in_3');
    expect(engine.intents.map((i) => [i.chatId, i.text])).toEqual([[CREW, 'dinner tonight?']]);
  });

  it('never guesses between two crews: asks again, then lets the draft go', async () => {
    const { engine, text, dmsTo } = await setup(
      new StubClassifier(),
      undefined,
      silentLogger,
      twoCrews(),
    );
    await text(AVA.handle, 'dinner tonight? thai', 'in_1');
    expect(dmsTo(AVA.handle)).toEqual([
      'Which crew? 1) the usual suspects  2) the boys  Or "new crew <name>".',
    ]);
    await text(AVA.handle, 'hmm', 'in_2');
    await text(AVA.handle, 'not sure', 'in_3');
    expect(dmsTo(AVA.handle)).toHaveLength(3);
    expect(engine.intents).toHaveLength(0);
    await text(AVA.handle, 'eh', 'in_4');
    expect(dmsTo(AVA.handle)[3]).toMatch(/^No worries 🫧/);
    expect(engine.intents).toHaveLength(0);
  });

  it('hands "new crew <name>" to the bubble and drops the draft', async () => {
    const { engine, text, dmsTo, privates } = await setup(
      new StubClassifier(),
      undefined,
      silentLogger,
      twoCrews(),
    );
    await text(AVA.handle, 'i want to eat food w my friends', 'in_1');
    await text(AVA.handle, 'new crew the lads', 'in_2');
    expect(privates.map((p) => p.text)).toEqual(['new crew the lads']);
    expect(dmsTo(AVA.handle).at(-1)).toBe("Once they've joined, tell me about dinner again.");
    expect(engine.intents).toHaveLength(0);
    // The draft is gone: a later reply is not taken as its answer.
    await text(AVA.handle, 'the boys, indian', 'in_3');
    expect(engine.intents).toHaveLength(0);
  });

  it('hands the bubble\'s bill flow over during a plan: "never mind" is not a cancel', async () => {
    const claims = (userId: string, t: string) =>
      userId === BEN.id && /covered|never mind|^\$?\d/.test(t);
    const { engine, text, privates } = await setup(
      new StubClassifier(),
      undefined,
      silentLogger,
      undefined,
      claims,
    );
    await text(AVA.handle, 'thai dinner today?', 'in_1');
    const intents = engine.intents.length;
    await text(BEN.handle, 'I covered dinner, can you tell them to pay me', 'in_2');
    await text(BEN.handle, 'never mind', 'in_3');
    expect(privates.map((p) => p.text)).toEqual([
      'I covered dinner, can you tell them to pay me',
      'never mind',
    ]);
    expect(engine.commands).toHaveLength(0);
    expect(engine.intents).toHaveLength(intents);
    // Someone the bubble does not claim still cancels as before.
    await text(CHLOE.handle, 'never mind', 'in_4');
    expect(engine.commands.map((c) => [c.userId, c.command])).toEqual([[CHLOE.id, 'cancel']]);
  });

  it('lets the draft expire after 10 minutes', async () => {
    const { engine, text, dmsTo } = await setup(
      new StubClassifier(),
      undefined,
      silentLogger,
      twoCrews(),
    );
    await text(AVA.handle, 'i want to eat food w my friends', 'in_1');
    expect(dmsTo(AVA.handle)).toHaveLength(1);
    vi.advanceTimersByTime(10 * 60_000 + 1);
    await text(AVA.handle, 'the boys, indian', 'in_2');
    expect(engine.intents).toHaveLength(0);
  });

  it('skips the questions when a plan is already open in the crew', async () => {
    const { engine, text, dmsTo } = await setup(
      new StubClassifier(),
      undefined,
      silentLogger,
      new FakeCrewDirectory(),
    );
    await text(AVA.handle, 'thai dinner with the usual suspects today?', 'in_1');
    expect(engine.intents).toHaveLength(1);
    await text(BEN.handle, 'dinner tonight?', 'in_2');
    expect(engine.intents.map((i) => [i.userId, i.chatId])).toEqual([
      [AVA.id, CREW],
      [BEN.id, CREW],
    ]);
    expect(dmsTo(BEN.handle).some((t) => t.includes('Which crew'))).toBe(false);
  });
});
