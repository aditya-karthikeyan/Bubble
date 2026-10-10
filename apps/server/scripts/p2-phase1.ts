/**
 * P2 Phase 1 demo: runs every MessagingPort method and prints inbound events.
 *
 *   pnpm p2:phase1           terminal provider, seeded demo crew (typing speaks as Ava)
 *   pnpm p2:phase1 --real    the real Photon line. LINE LOCK first. Messages only the phones in
 *                            P2_PHASE1_PHONES (comma-separated E.164, registered with Photon,
 *                            and each has texted their bubble once).
 *
 * Prints PASS/FAIL per method, then listens P2_PHASE1_LISTEN_S seconds (default 60): reply
 * with text, tap 👍 on the headcount line, and vote in the poll to see each inbound event.
 */
import { DEMO_GROUP, PERSONAS } from '@bubbleworks/shared/fakes';
import { crewChatId, idempotencyKey } from '@bubbleworks/shared';
import { loadConfig } from '../src/config.js';
import type { Logger } from '../src/events/bus.js';
import { createMessaging, dmChatId, loadMessagingConfig } from '../src/messaging/index.js';
import { PhotonUsers } from '../src/messaging/photon-users.js';
import { createRuntime } from '../src/runtime.js';

const real = process.argv.includes('--real');
const listenSeconds = Number(process.env['P2_PHASE1_LISTEN_S'] ?? 60);

const log: Logger = {
  info: (obj, msg) => console.log(`  · ${msg ?? ''} ${JSON.stringify(obj)}`),
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

// Crew: the seeded demo crew on the terminal, real registered phones on the line.
let crewId = DEMO_GROUP.id;
if (real) {
  const phones = (process.env['P2_PHASE1_PHONES'] ?? '').split(',').filter(Boolean);
  if (!phones.length) throw new Error('Set P2_PHASE1_PHONES to the phones to message');
  const photon = new PhotonUsers({
    apiUrl: config.SPECTRUM_API_URL,
    projectId: config.SPECTRUM_PROJECT_ID!,
    projectSecret: config.SPECTRUM_PROJECT_SECRET!,
  });
  const ids: string[] = [];
  for (const phone of phones) {
    const bubbleNumber = await photon.bubbleNumberFor(phone);
    if (!bubbleNumber) throw new Error(`…${phone.slice(-4)} is not registered with Photon`);
    const user = await runtime.crews.createUser({
      displayName: `…${phone.slice(-4)}`,
      handle: phone,
      bubbleNumber,
    });
    // Each phone already texted its bubble during the Phase 0 spike.
    await runtime.crews.updateUser(user.id, { onboardedAt: new Date().toISOString() });
    ids.push(user.id);
    console.log(`crew member …${phone.slice(-4)} bubble …${bubbleNumber.slice(-4)}`);
  }
  let crew = await runtime.crews.createCrew({
    name: 'phase 1 crew',
    createdByUserId: ids[0]!,
    memberIds: ids,
  });
  for (const id of ids) crew = await runtime.crews.confirmMember(crew.id, id);
  crewId = crew.id;
}

const messaging = createMessaging({ config, runtime });
const { port } = messaging;
port.onGroupMessage(async (m) =>
  console.log(
    `<- group ${m.userId}: ${JSON.stringify(m.text)}${m.replyToMessageId ? ` (reply to ${m.replyToMessageId})` : ''}`,
  ),
);
port.onPrivateMessage(async (m) =>
  console.log(`<- private ${m.userId}: ${JSON.stringify(m.text)}`),
);
port.onReaction(async (r) => console.log(`<- reaction ${r.userId}: ${r.emoji} on ${r.messageId}`));
port.onPollVote(async (v) =>
  console.log(`<- vote ${v.userId}: [${v.choices.join(', ')}] (${v.pollId})`),
);
await messaging.start();

const chatId = crewChatId(crewId);
const firstMember = (await runtime.crews.membersOf(crewId))[0]!.id;
const planId = `plan_p2demo${Date.now()}`;
const key = (action: string, ...parts: string[]) => idempotencyKey(planId, action, ...parts);
const results: Array<[string, boolean, number, string]> = [];

async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  const t0 = performance.now();
  try {
    const out = await fn();
    const note =
      out && typeof out === 'object' && 'messageId' in out
        ? String(out.messageId).slice(0, 40)
        : '';
    results.push([name, true, Math.round(performance.now() - t0), note]);
  } catch (err) {
    results.push([name, false, Math.round(performance.now() - t0), String(err).slice(0, 100)]);
  }
  const [, ok, ms, note] = results.at(-1)!;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ms}ms ${note}`);
  await new Promise((r) => setTimeout(r, real ? 1500 : 100));
}

let headcountId = '';
await step('setTyping on (crew)', () => port.setTyping({ chatId, typing: true }));
await step('sendPrivateText', () =>
  port.sendPrivateText({
    userId: firstMember,
    text: '🫧 Bubbleworks Phase 1 check. Your bubble is online.',
    idempotencyKey: key('hello'),
  }),
);
await step('sendPrivateText (same key, deduplicated)', async () => {
  const r = await port.sendPrivateText({
    userId: firstMember,
    text: 'should not send',
    idempotencyKey: key('hello'),
  });
  if (!r.deduplicated) throw new Error('expected deduplicated');
  return r;
});
await step('setTyping off (crew)', () => port.setTyping({ chatId, typing: false }));
await step('sendGroupText (fan out)', () =>
  port.sendGroupText({
    chatId,
    text: '🫧 Plan starting: dinner tonight',
    idempotencyKey: key('start'),
  }),
);
await step('sendPoll (crew)', () =>
  port.sendPoll({
    chatId,
    planId,
    pollId: 'poll_cuisine',
    question: 'What are we eating?',
    options: [
      { key: 'thai', label: 'Thai' },
      { key: 'sushi', label: 'Sushi' },
      { key: 'pizza', label: 'Pizza' },
    ],
    idempotencyKey: key('poll_cuisine'),
  }),
);
await step('sendGroupText headcount', async () => {
  const r = await port.sendGroupText({
    chatId,
    text: "Tap 👍 on this message if you're in.",
    idempotencyKey: key('headcount'),
  });
  headcountId = r.messageId;
  return r;
});
await step('sendRichLink (crew)', () =>
  port.sendRichLink({
    chatId,
    url: 'https://photon.codes',
    title: 'Watch the bubbles',
    idempotencyKey: key('link'),
  }),
);
await step('upsertLiveCard (create)', () =>
  port.upsertLiveCard({
    chatId,
    planId,
    card: { title: 'Dinner, deciding', lines: ['3 bubbles in', 'closes 7:05'] },
    idempotencyKey: key('card'),
  }),
);
await step('upsertLiveCard (edit in place)', () =>
  port.upsertLiveCard({
    chatId,
    planId,
    card: { title: 'Dinner, locked', lines: ['Thai Basil 7:30'] },
    idempotencyKey: key('card', '2'),
  }),
);
await step('editMessage (crew copies)', () =>
  port.editMessage({
    chatId,
    messageId: headcountId,
    text: "Tap 👍 on this message if you're in (closes 7:05).",
  }),
);
await step('react (crew copies)', () =>
  port.react({ chatId, messageId: headcountId, emoji: '‼️' }),
);
await step('replyInThread (crew copies)', () =>
  port.replyInThread({
    chatId,
    text: 'Headcount so far: counting 👍',
    replyToMessageId: headcountId,
    idempotencyKey: key('thread'),
  }),
);
await step('renameGroup (no-op on crews)', () => port.renameGroup({ chatId, name: 'x' }));
if (!real) {
  await step('signup', () =>
    messaging.signup({ name: 'Dee Demo', email: 'dee@example.com', phone: '+15550000099' }),
  );
}

console.log(
  `\nListening ${listenSeconds}s: reply with text, tap 👍 on the headcount line, vote in the poll.`,
);
await new Promise((r) => setTimeout(r, listenSeconds * 1000));
await step('closePoll (announces leader)', () =>
  port.closePoll({ chatId, pollId: 'poll_cuisine' }),
);
await step('dm chat id works for one person', () =>
  port.sendGroupText({
    chatId: dmChatId(firstMember),
    text: 'Done. Thanks 🫧',
    idempotencyKey: key('bye'),
  }),
);

console.log('\nMethod | Result | ms | Notes');
for (const [name, ok, ms, note] of results)
  console.log(`${name} | ${ok ? 'PASS' : 'FAIL'} | ${ms} | ${note}`);
await messaging.stop();
runtime.close();
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
