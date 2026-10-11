/**
 * pnpm p3:phase4
 * Prints the demo crew's fairness ledger before and after a simulated booked plan (votes, an
 * accepted concession, a represented member, the Splitter's payer rotation), a post-dinner
 * reaction, and then runs the privacy tests and prints their results.
 */
import { spawnSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { newId } from '@bubbleworks/shared';
import { FakeMessaging } from '@bubbleworks/shared/fakes';
import { RuleExtractor } from '../../src/bubbles/extract.js';
import { RuleReactionClassifier } from '../../src/bubbles/reactions.js';
import { seedDemoBubbles } from '../../src/bubbles/seed.js';
import { DbBubbleService } from '../../src/bubbles/service.js';
import { loadConfig } from '../../src/config.js';
import { asks, bookings, plans, votes } from '../../src/db/schema.js';
import { Doers } from '../../src/doers/index.js';
import { createRuntime } from '../../src/runtime.js';

const rt = createRuntime(loadConfig({ NODE_ENV: 'test', SEED_ON_BOOT: 'true' }), {
  dbPath: ':memory:',
  seed: true,
});
const messaging = new FakeMessaging({ print: false });
const bubbles = new DbBubbleService({
  db: rt.db,
  crews: rt.crews,
  messaging,
  extractor: new RuleExtractor(),
  reactions: new RuleReactionClassifier(),
});
const doers = new Doers({
  db: rt.db,
  crews: rt.crews,
  bubbles,
  messaging,
  timers: rt.timers,
  bus: rt.bus,
  publicBaseUrl: 'http://localhost:3001',
  linkSecret: 'demo',
});
console.log('demo seed:', seedDemoBubbles(rt.db));

const names: Record<string, string> = {};
for (const u of await rt.crews.membersOf('group_demo')) names[u.id] = u.displayName;
const table = (title: string) => {
  console.log(`\n== ${title} ==`);
  console.table(
    doers.ledger.summary('group_demo').map((r) => ({
      who: names[r.userId],
      paid: r.paid,
      compromised: r.compromised,
      got_preference: r.got,
    })),
  );
};
table('ledger before');

// Two hours ago: Ava organized; Ava wanted thai, Ben pizza, Chloe mediterranean; Chloe accepted
// a budget concession; Dev was busy and represented; Alpha Pie (pizza) won.
const venue = rt.venues().find((v) => v.name === 'Alpha Pie')!;
const startAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
const plan = rt.plans.create({
  groupId: 'group_demo',
  chatId: 'crew:group_demo',
  intent: {
    meal: 'dinner',
    date: startAt.slice(0, 10),
    startMinutes: null,
    cuisine: null,
    rawText: 'dinner tonight?',
  },
  createdByUserId: 'user_ava',
});
for (const id of ['user_ava', 'user_ben', 'user_chloe']) rt.plans.upsertMember(plan.id, id, 'in');
rt.plans.upsertMember(plan.id, 'user_dev', 'represented', true);
rt.plans.setChoice(plan.id, { chosenVenueId: venue.id, backupVenueId: null, startAt });
rt.db.update(plans).set({ state: 'BOOKED' }).where(eq(plans.id, plan.id)).run();
const at = new Date().toISOString();
for (const [userId, choice] of [
  ['user_ava', 'thai'],
  ['user_ben', 'pizza'],
  ['user_chloe', 'mediterranean'],
] as const) {
  rt.db
    .insert(votes)
    .values({
      id: newId('vote'),
      planId: plan.id,
      pollId: 'poll',
      kind: 'cuisine',
      userId,
      choice,
      at,
    })
    .run();
}
rt.db
  .insert(asks)
  .values({
    id: newId('ask'),
    planId: plan.id,
    userId: 'user_chloe',
    kind: 'budget',
    concession: { factType: 'budget_max', from: '20', to: '30', cost: 3 },
    text: '(private)',
    status: 'accepted',
    idempotencyKey: 'demo-ask',
    sentAt: at,
    expiresAt: at,
  })
  .run();
const bookingId = newId('booking');
rt.db
  .insert(bookings)
  .values({
    id: bookingId,
    planId: plan.id,
    venueId: venue.id,
    status: 'booked',
    partySize: 4,
    startAt,
    reservationName: 'Ava',
    idempotencyKey: 'demo-b',
    createdAt: at,
    updatedAt: at,
  })
  .run();

console.log(
  `\nsimulated plan: ${venue.name} (${venue.cuisine}), Dev represented, Chloe accepted a concession`,
);
const split = await doers.splitter.send({
  bookingId,
  planId: plan.id,
  chatId: 'crew:group_demo',
  venue,
  startAt,
  partySize: 4,
  reservationName: 'Ava',
  confirmationCode: null,
  members: rt.plans.members(plan.id),
  idempotencyKey: 'demo-split',
});
console.log(
  'splitter:',
  split.detail,
  '(Ava and Ben have paid before; Chloe has compromised most, so Dev fronts it)',
);
await rt.bus.publish({
  type: 'booking_confirmed',
  planId: plan.id,
  at,
  bookingId,
  venue: { venueId: venue.id, name: venue.name, cuisine: venue.cuisine },
  startAt,
  partySize: 4,
  reservationName: 'Ava',
});
await new Promise((r) => setTimeout(r, 20));
for (const r of doers.ledger.recordPlan(plan.id)) {
  console.log(
    `  ledger +${r.kind.padEnd(14)} ${names[r.userId]} ${r.amount}${r.note ? ` (${r.note})` : ''}`,
  );
}
table('ledger after');
const chloe = await bubbles.getProfile('user_chloe');
console.log(
  `Chloe's recentCompromiseCount is now ${chloe.recentCompromiseCount}, so her next concession costs more.`,
);

console.log('\n== reactions (post-dinner) ==');
for (const [userId, text] of [
  ['user_ben', 'that place was mid'],
  ['user_ava', 'the food was so good'],
  ['user_chloe', 'see you all tomorrow'],
] as const) {
  console.log(
    `  ${names[userId]}: "${text}" -> ${(await bubbles.reactTo({ messageId: newId('m'), userId, text, at })) ?? 'no change'}`,
  );
}
rt.close();

console.log('\n== privacy tests ==');
// Vitest runs from the repo root, where vitest.config.ts lives.
const run = spawnSync(
  'pnpm exec vitest run apps/server/src/bubbles/phase4.test.ts apps/server/src/bubbles/bubbles.test.ts -t "privacy|never puts facts|forget me"',
  {
    encoding: 'utf8',
    shell: true,
    cwd: '../..',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  },
);
const out = run.stdout + run.stderr;
for (const line of out.split('\n')) {
  if (/✓|×|Tests\s+\d|Test Files/.test(line)) console.log(' ', line.trim());
}
