/**
 * pnpm p3:phase2
 * Feeds twenty scripted chat lines from three people through the background learner (live Haiku
 * when ANTHROPIC_API_KEY is set), then prints the facts table, learner stats, and signal
 * latencies: Find My for P3_TEST_ADDRESS (cold, then warm), Google free/busy for the calendar
 * connected in Phase 0 (.tokens/google-spike.json), and presence. Coordinates are never printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Credentials } from 'google-auth-library';
import { FakeMessaging } from '@bubbleworks/shared/fakes';
import { createBubbles } from '../../src/bubbles/index.js';
import { loadConfig } from '../../src/config.js';
import { bubbleState } from '../../src/db/schema.js';
import { createRuntime } from '../../src/runtime.js';

const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ''));
const rt = createRuntime(loadConfig({ ...env, SEED_ON_BOOT: 'true' }), {
  dbPath: ':memory:',
  seed: true,
});
const messaging = new FakeMessaging({ print: false });
const bubbles = createBubbles({ runtime: rt, messaging, env });
const svc = bubbles.service;

const mk = async (name: string, phone: string) => {
  const u = await rt.crews.createUser({ displayName: name, handle: phone });
  rt.db
    .insert(bubbleState)
    .values({ userId: u.id, onboardingCompletedAt: new Date().toISOString(), updatedAt: '' })
    .run();
  return u;
};
const mahil = await mk('Mahil', env['P3_TEST_ADDRESS'] ?? '+19195550301');
const soham = await mk('Soham', '+19195550302');
const pranav = await mk('Pranav', '+19195550303');

const LINES: Array<[typeof mahil, string]> = [
  [soham, 'yo who is down for food later'],
  [pranav, 'me'],
  [mahil, 'i could eat'],
  [soham, "btw I'm allergic to shellfish so no seafood boil"],
  [pranav, 'lol noted'],
  [mahil, 'broke till friday, nothing over $15 for me'],
  [pranav, 'I love thai honestly'],
  [soham, 'ok'],
  [mahil, 'not a fan of sushi tbh'],
  [pranav, "I'm vegetarian now btw, started last month"],
  [soham, 'haha'],
  [mahil, 'my venmo is @mahil-p'],
  [pranav, 'see you at 7'],
  [soham, 'that place last week was mid'],
  [mahil, 'cool'],
  [pranav, "can't do spicy food at all"],
  [soham, 'Alpha Pie is my favorite'],
  [mahil, '👍'],
  [pranav, 'I live near Franklin St'],
  [soham, 'k bye'],
];

console.log(
  `extractor: ${env['ANTHROPIC_API_KEY'] ? 'Haiku' : 'rules'} | Find My: ${env['SPECTRUM_PROJECT_ID'] ? 'Photon Pro' : 'off'} | calendar: ${bubbles.google ? 'Google' : 'off'}\n`,
);

const t0 = performance.now();
let maxEnqueueMs = 0;
for (const [i, [u, text]] of LINES.entries()) {
  const e0 = performance.now();
  svc.learn({ messageId: `line-${i}`, userId: u.id, text, at: new Date().toISOString() });
  maxEnqueueMs = Math.max(maxEnqueueMs, performance.now() - e0);
}
console.log(
  `enqueued 20 lines; slowest enqueue ${maxEnqueueMs.toFixed(2)} ms (plan path never waits)`,
);
await svc.learner.idle();
console.log(
  `learner drained in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
  svc.learner.stats,
  '\n',
);

console.log('== facts learned ==');
const names = new Map([mahil, soham, pranav].map((u) => [u.id, u.displayName]));
console.table(
  [mahil, soham, pranav].flatMap((u) =>
    svc.facts.active(u.id).map((f) => ({
      who: names.get(u.id),
      type: f.type,
      value: f.value,
      hard: f.hard,
      confirmed: f.confirmed,
      expiresAt: f.expiresAt ?? '',
    })),
  ),
);
const asks = messaging.sent.flatMap((s) =>
  s.kind === 'private_text' ? [`${names.get(s.input.userId)}: ${s.input.text}`] : [],
);
console.log('private confirmation asks:\n  ' + asks.join('\n  ') + '\n');

console.log('== signal latencies (budget 300 ms) ==');
const row = (signal: string, r: { from: string; ms: number; ageMs: number | null }, note = '') =>
  console.log(
    `${signal.padEnd(22)} ${String(r.ms).padStart(5)} ms  from=${r.from.padEnd(5)} age=${r.ageMs === null ? '-' : `${Math.round(r.ageMs / 1000)}s`} ${note}`,
  );

const cold = await svc.readLocation(mahil.id);
row('location (cold)', cold, cold.value ? 'fix found' : 'still fetching in background');
const w0 = performance.now();
while (!svc.locationCache.peek(mahil.id) && performance.now() - w0 < 20_000) {
  await new Promise((r) => setTimeout(r, 250));
}
console.log(
  `  background Find My fetch landed after ~${((performance.now() - w0) / 1000).toFixed(1)} s more`,
);
const warm = await svc.readLocation(mahil.id);
row('location (warm)', warm, warm.value ? 'fix found' : 'not sharing');
const p0 = performance.now();
const loc = await svc.getLocation(pranav.id);
console.log(
  `${'location (fallback)'.padEnd(22)} ${String(Math.round(performance.now() - p0)).padStart(5)} ms  Pranav not sharing -> ${loc ? 'Franklin St venue center' : 'null'}`,
);

if (bubbles.google && existsSync('../../.tokens/google-spike.json')) {
  const { tokens } = JSON.parse(readFileSync('../../.tokens/google-spike.json', 'utf8')) as {
    tokens: Credentials;
  };
  bubbles.tokens.save(soham.id, tokens);
  const now = new Date();
  const range = {
    start: now.toISOString(),
    end: new Date(now.getTime() + 6 * 3_600_000).toISOString(),
  };
  const fb1 = await svc.readBusy(soham.id, range);
  row('freebusy (cold)', fb1, `${fb1.value?.length ?? 0} busy blocks`);
  await new Promise((r) => setTimeout(r, 1500));
  const fb2 = await svc.readBusy(soham.id, range);
  row('freebusy (warm)', fb2, `${fb2.value?.length ?? 0} busy blocks`);
} else {
  console.log('freebusy: skipped (no Google config or no .tokens/google-spike.json from Phase 0)');
}

for (const u of [mahil, soham, pranav]) {
  const s0 = performance.now();
  const p = await svc.getPresence(u.id);
  console.log(
    `${`presence ${u.displayName}`.padEnd(22)} ${String(Math.round(performance.now() - s0)).padStart(5)} ms  ${p}`,
  );
}

await bubbles.close();
rt.close();
