/**
 * P2 Phase 2 demo: detection -> typing -> engine -> question bundle -> headcount and votes.
 * Uses a stand-in engine (SimEngine) with P1's question policy shape until the real engine
 * lands; it closes the cuisine poll once every member has voted and logs the winner.
 *
 *   pnpm p2:phase2           terminal provider, demo crew (typing speaks as Ava)
 *   pnpm p2:phase2 --real    the real line. LINE LOCK first. P2_PHASE1_PHONES = crew phones
 *                            (registered with Photon, each texted their bubble once).
 *
 * Then text your bubble "dinner today?" and watch the timing marks: t_typing, t_detect,
 * t_poll_posted. Tap 👍 on the headcount line, reply "I'm in", vote in the poll.
 */
import {
  crewChatId,
  type AskAnswerInput,
  type CallResult,
  type CommandInput,
  type HeadcountInput,
  type IntentInput,
  type IntentResult,
  type MemberChangeInput,
  type PlanEngine,
  type VoteInput,
} from '@bubbleworks/shared';
import { DEMO_GROUP, PERSONAS } from '@bubbleworks/shared/fakes';
import { loadConfig } from '../src/config.js';
import type { Logger } from '../src/events/bus.js';
import { createMessaging, loadMessagingConfig, type PlanIntake } from '../src/messaging/index.js';
import { PhotonUsers } from '../src/messaging/photon-users.js';
import { createRuntime } from '../src/runtime.js';

const real = process.argv.includes('--real');
const listenSeconds = Number(process.env['P2_PHASE2_LISTEN_S'] ?? 240);

const log: Logger = {
  info: (obj, msg) => {
    if (msg === 'timing')
      console.log(`⏱  ${String(obj['mark'])} ${String(obj['ms'])}ms ${JSON.stringify(obj)}`);
    else if (msg === 'headcount' || msg === 'classifier')
      console.log(`  · ${msg} ${JSON.stringify(obj)}`);
  },
  warn: (obj, msg) => console.log(`  ! ${msg ?? ''} ${JSON.stringify(obj)}`),
  error: (obj, msg) => console.log(`  ✗ ${msg ?? ''} ${JSON.stringify(obj)}`),
  debug: () => undefined,
};

const config = loadMessagingConfig({
  ...process.env,
  SPECTRUM_PROVIDER: real ? 'imessage' : 'terminal',
  MESSAGING_TERMINAL_PHONE: PERSONAS[0]!.handle,
});
const runtime = createRuntime(loadConfig({ NODE_ENV: 'development', SEED_ON_BOOT: 'true' }), {
  dbPath: ':memory:',
  seed: true,
  log,
});

let crewId = DEMO_GROUP.id;
if (real) {
  const phones = (process.env['P2_PHASE1_PHONES'] ?? '').split(',').filter(Boolean);
  if (!phones.length) throw new Error('Set P2_PHASE1_PHONES to the crew phones');
  const photon = new PhotonUsers({
    apiUrl: config.SPECTRUM_API_URL,
    projectId: config.SPECTRUM_PROJECT_ID!,
    projectSecret: config.SPECTRUM_PROJECT_SECRET!,
  });
  // Names come from Photon's user list (first name), so each phone shows its own person.
  const names = await photon.firstNames();
  const ids: string[] = [];
  for (const phone of phones) {
    const bubbleNumber = await photon.bubbleNumberFor(phone);
    if (!bubbleNumber) throw new Error(`…${phone.slice(-4)} is not registered with Photon`);
    const user = await runtime.crews.createUser({
      displayName: names.get(phone) ?? `…${phone.slice(-4)}`,
      handle: phone,
      bubbleNumber,
    });
    await runtime.crews.updateUser(user.id, { onboardedAt: new Date().toISOString() });
    ids.push(user.id);
  }
  let crew = await runtime.crews.createCrew({
    name: 'phase 2 crew',
    createdByUserId: ids[0]!,
    memberIds: ids,
  });
  for (const id of ids) crew = await runtime.crews.confirmMember(crew.id, id);
  crewId = crew.id;
}

/** Stand-in for P1's engine: opens a plan, asks cuisine, closes the poll when everyone voted. */
class SimEngine implements PlanEngine {
  intake!: PlanIntake;
  private plan: {
    id: string;
    chatId: string;
    votes: Map<string, string[]>;
    members: number;
  } | null = null;

  async handleIntent(input: IntentInput): Promise<IntentResult> {
    if (this.plan) return { planId: this.plan.id, created: false };
    const members = (await runtime.crews.membersOf(crewId)).length;
    const organizer = await runtime.crews.userById(input.userId);
    this.plan = { id: `plan_sim${Date.now()}`, chatId: input.chatId, votes: new Map(), members };
    console.log(`engine: plan ${this.plan.id} for "${input.text}"`);
    await this.intake.renderBundle({
      planId: this.plan.id,
      chatId: input.chatId,
      organizerName: organizer?.displayName ?? 'Someone',
      meal: 'dinner',
      cuisinePoll: {
        pollId: `${this.plan.id}_cuisine`,
        options: [
          { key: 'thai', label: 'Thai' },
          { key: 'sushi', label: 'Sushi' },
          { key: 'pizza', label: 'Pizza' },
        ],
      },
      headcount: {
        closesAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        timezone: 'America/New_York',
      },
      pageUrl: 'https://photon.codes',
    });
    return { planId: this.plan.id, created: true };
  }

  async handleVote(input: VoteInput): Promise<void> {
    if (!this.plan) return;
    this.plan.votes.set(input.userId, input.choices);
    console.log(`engine: vote ${input.userId} -> [${input.choices.join(', ')}]`);
    const voted = [...this.plan.votes.values()].filter((c) => c.length > 0).length;
    if (voted >= this.plan.members) {
      await messaging.port.closePoll({ chatId: this.plan.chatId, pollId: input.pollId });
      const tally = new Map<string, number>();
      for (const choices of this.plan.votes.values())
        for (const c of choices) tally.set(c, (tally.get(c) ?? 0) + 1);
      console.log(
        `engine: poll decided, solver winner cuisine = ${[...tally].sort((a, b) => b[1] - a[1])[0]?.[0]}`,
      );
    }
  }

  async handleHeadcount(input: HeadcountInput): Promise<void> {
    console.log(`engine: headcount ${input.userId} ${input.in ? 'IN' : 'OUT'}`);
  }
  async handleAskAnswer(_input: AskAnswerInput): Promise<void> {}
  async handleMemberChange(_input: MemberChangeInput): Promise<void> {}
  async handleCallResult(_result: CallResult): Promise<void> {}
  /** Stand-in replies; the real engine has its own pause and explain logic. */
  async handleCommand(input: CommandInput): Promise<void> {
    console.log(
      `engine: command ${input.command} from ${input.userId} (plan ${input.planId ?? '-'})`,
    );
    const replies: Record<string, string> = {
      wait: 'Paused. Say "resume" when you want me to carry on.',
      resume: 'Picking it back up.',
      why: "It fits every bubble's limits and had the most support. Nobody's private details leave the server.",
      veto: 'Got it, finding somewhere else.',
      cancel: 'Plan cancelled.',
    };
    await messaging.port.sendPrivateText({
      userId: input.userId,
      text: replies[input.command] ?? 'Okay.',
      idempotencyKey: `${input.planId ?? 'none'}:cmd:${input.messageId}`,
    });
  }
}

const messaging = createMessaging({ config, runtime });
const engine = new SimEngine();
engine.intake = messaging.attachEngine(engine);
messaging.port.onPrivateMessage(async (m) =>
  console.log(`<- private (to P3 bubble): ${JSON.stringify(m.text)}`),
);
await messaging.start();
console.log(
  `\nReady (${real ? 'real line' : 'terminal'}). Crew ${crewChatId(crewId)}. Text your bubble "dinner today?". Listening ${listenSeconds}s.`,
);
await new Promise((r) => setTimeout(r, listenSeconds * 1000));
await messaging.stop();
runtime.close();
process.exit(0);
