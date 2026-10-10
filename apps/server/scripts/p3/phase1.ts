/**
 * pnpm p3:phase1 [--chat]
 * Runs a real onboarding (live Haiku when ANTHROPIC_API_KEY is set) against an in-memory
 * database and prints the transcript, the stored profile, and the elapsed time. --chat lets you
 * type as the new person instead of the scripted answers. Then it declares a crew with a seeded
 * persona and confirms it, to show the crew flow end to end.
 */
import { createInterface } from 'node:readline/promises';
import { FakeMessaging } from '@bubbleworks/shared/fakes';
import { createBubbles } from '../../src/bubbles/index.js';
import { loadConfig } from '../../src/config.js';
import { createRuntime } from '../../src/runtime.js';

const SCRIPT = [
  'hey!',
  "I'm vegetarian and allergic to peanuts",
  'yes',
  'usually like $20-30, but broke till Friday so $15',
  'Franklin St mostly',
  'Alpha Pie and Bonchon',
  '@sam-eats',
];

// Blank lines from .env.example (SERVER_PUBLIC_URL=) fail config validation; treat them as unset.
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ''));
const config = loadConfig({ ...env, SEED_ON_BOOT: 'true' });
const rt = createRuntime(config, { dbPath: ':memory:', seed: true });
const messaging = new FakeMessaging({ print: false });
const bubbles = createBubbles({ runtime: rt, messaging, env });
const service = bubbles.service;

let n = 0;
let printed = 0;
const flush = () => {
  for (; printed < messaging.sent.length; printed++) {
    const s = messaging.sent[printed]!;
    if (s.kind !== 'private_text') continue;
    const who = s.input.userId === sam.id ? 'bubble → Sam' : `bubble → ${s.input.userId}`;
    console.log(`  ${who}: ${s.input.text.replace(/\n/g, '\n      ')}`);
  }
};

const sam = await rt.crews.createUser({
  displayName: 'Sam',
  handle: '+19195550199',
  bubbleNumber: '+16285550199',
});
console.log(
  `extractor: ${process.env['ANTHROPIC_API_KEY'] ? 'Haiku (claude-haiku-4-5-20251001)' : 'rules (no ANTHROPIC_API_KEY)'}`,
);
console.log(`calendar link: ${bubbles.google ? 'on' : 'off (GOOGLE_CLIENT_ID unset)'}\n`);

const say = async (userId: string, text: string, label = 'Sam') => {
  console.log(`${label}: ${text}`);
  const t0 = performance.now();
  await service.onPrivateMessage({
    messageId: `demo-${++n}`,
    userId,
    text,
    at: new Date().toISOString(),
  });
  flush();
  console.log(`  (${Math.round(performance.now() - t0)} ms)\n`);
};

const started = performance.now();
if (process.argv.includes('--chat')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log('Type as Sam. Empty line ends.\n');
  for (;;) {
    const line = (await rl.question('> ')).trim();
    if (!line) break;
    await say(sam.id, line);
    if (service.isOnboarded(sam.id)) console.log('(onboarding complete; keep chatting or Enter)');
  }
  rl.close();
} else {
  for (const line of SCRIPT) await say(sam.id, line);
}
const seconds = ((performance.now() - started) / 1000).toFixed(1);

console.log('== stored profile ==');
const profile = await service.getProfile(sam.id);
console.table(
  profile.facts.map((f) => ({
    type: f.type,
    value: f.value,
    hard: f.hard,
    confirmed: f.confirmed,
    source: f.source,
    expiresAt: f.expiresAt ?? '',
  })),
);
console.log(`onboarded: ${service.isOnboarded(sam.id)} in ${seconds} s of processing\n`);

if (service.isOnboarded(sam.id)) {
  console.log('== crew flow (Ava is a seeded persona) ==');
  // Seeded personas count as onboarded for the demo.
  await service.onPrivateMessage({ messageId: 'ava-0', userId: 'user_ava', text: 'hi', at: '' });
  for (const [i, t] of ['none', '30', 'downtown', 'skip', 'skip'].entries()) {
    await service.onPrivateMessage({
      messageId: `ava-${i + 1}`,
      userId: 'user_ava',
      text: t,
      at: '',
    });
  }
  printed = messaging.sent.length;
  await say(sam.id, 'my crew is Ava called Friday Dinner');
  await say('user_ava', 'yes', 'Ava');
  const crew = (await rt.crews.crewsOf(sam.id)).find((g) => g.name === 'Friday Dinner');
  console.log(`crew: ${crew?.name} status=${crew?.status} chatId=${crew?.chatId}`);
}
rt.close();
