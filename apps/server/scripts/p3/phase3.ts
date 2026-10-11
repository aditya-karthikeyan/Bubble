/**
 * pnpm p3:phase3
 * A simulated booking through all three doers and absent representation, on the seeded demo
 * crew (Ava, Ben, Chloe in; Dev busy and represented). Prints every DM each person would get,
 * the .ics the Inviter serves, the Venmo links, the represented member's summary, and three
 * Watcher passes with Chloe running late. Uses fakes for messaging and the caller.
 */
import Fastify from 'fastify';
import { newId, type BookingSummary } from '@bubbleworks/shared';
import { FakeMessaging } from '@bubbleworks/shared/fakes';
import { RuleExtractor } from '../../src/bubbles/extract.js';
import { DbBubbleService } from '../../src/bubbles/service.js';
import type { LocationFix } from '../../src/bubbles/signals.js';
import { loadConfig } from '../../src/config.js';
import { bookings } from '../../src/db/schema.js';
import { Doers } from '../../src/doers/index.js';
import { createRuntime } from '../../src/runtime.js';

const START = new Date(Date.now() + 40 * 60_000); // dinner in 40 minutes
START.setSeconds(0, 0);
let nowMs = Date.now();
const rt = createRuntime(loadConfig({ NODE_ENV: 'test', SEED_ON_BOOT: 'true' }), {
  dbPath: ':memory:',
  seed: true,
  timers: { now: () => nowMs },
});
const messaging = new FakeMessaging({ print: false });
const venue = rt.venues().find((v) => v.name === 'Alpha Pie')!;
const fixes = new Map<string, LocationFix | null>();
const bubbles = new DbBubbleService({
  db: rt.db,
  crews: rt.crews,
  messaging,
  extractor: new RuleExtractor(),
  locations: {
    get: async (phone) => {
      const u = await rt.crews.userByHandle(phone);
      return u ? (fixes.get(u.id) ?? null) : null;
    },
  },
  now: () => new Date(nowMs),
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
  onLate: async (n) =>
    console.log(`  >> engine: caller.holdTable(${venue.name}, ${n.minutesLate} min late)`),
  now: () => new Date(nowMs),
});

const names: Record<string, string> = {};
for (const id of ['user_ava', 'user_ben', 'user_chloe', 'user_dev', 'user_eli']) {
  names[id] = (await rt.crews.userById(id))?.displayName ?? id;
}
let printed = 0;
const flush = () => {
  for (; printed < messaging.sent.length; printed++) {
    const s = messaging.sent[printed]!;
    if (s.kind === 'private_text') console.log(`  DM → ${names[s.input.userId]}: ${s.input.text}`);
    if (s.kind === 'group_text') console.log(`  crew: ${s.input.text}`);
    if (s.kind === 'live_card') {
      console.log(`  live card "${s.input.card.title}": ${s.input.card.lines.join(' | ')}`);
    }
  }
};

// Dev texted "busy" earlier, so the engine represented him.
await bubbles.onPrivateMessage({ messageId: 'dev-busy', userId: 'user_dev', text: 'busy', at: '' });
printed = messaging.sent.length;

const plan = rt.plans.create({
  groupId: 'group_demo',
  chatId: 'crew:group_demo',
  intent: {
    meal: 'dinner',
    date: START.toISOString().slice(0, 10),
    startMinutes: null,
    cuisine: null,
    rawText: 'dinner tonight?',
  },
  createdByUserId: 'user_ava',
});
for (const id of ['user_ava', 'user_ben', 'user_chloe']) rt.plans.upsertMember(plan.id, id, 'in');
rt.plans.upsertMember(plan.id, 'user_dev', 'represented', true);
rt.plans.setChoice(plan.id, {
  chosenVenueId: venue.id,
  backupVenueId: null,
  startAt: START.toISOString(),
});
const bookingId = newId('booking');
rt.db
  .insert(bookings)
  .values({
    id: bookingId,
    planId: plan.id,
    venueId: venue.id,
    status: 'booked',
    partySize: 4,
    startAt: START.toISOString(),
    reservationName: 'Ava',
    confirmationCode: 'BW42',
    idempotencyKey: `demo-${bookingId}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  .run();
const summary: BookingSummary = {
  bookingId,
  planId: plan.id,
  chatId: 'crew:group_demo',
  venue,
  startAt: START.toISOString(),
  partySize: 4,
  reservationName: 'Ava',
  confirmationCode: 'BW42',
  members: rt.plans.members(plan.id),
};

console.log(
  `\n== plan locks: ${venue.name} at ${START.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })} (Dev is busy, represented) ==`,
);
await rt.bus.publish({
  type: 'plan_locked',
  planId: plan.id,
  at: new Date().toISOString(),
  venue: { venueId: venue.id, name: venue.name, cuisine: venue.cuisine },
  backup: null,
  startAt: START.toISOString(),
  partySize: 4,
});
await new Promise((r) => setTimeout(r, 20));
flush();

console.log('\n== Inviter ==');
console.log(' ', await doers.inviter.send({ ...summary, idempotencyKey: `${plan.id}:inviter` }));
flush();
const app = Fastify();
doers.registerRoutes(app);
const link = messaging.sent
  .flatMap((s) => (s.kind === 'private_text' ? [s.input.text] : []))
  .find((t) => t.includes('/ics/'))!;
const res = await app.inject({
  method: 'GET',
  url: /http:\/\/localhost:3001(\/ics\/\S+)/.exec(link)![1]!,
});
console.log(`  GET .ics -> ${res.statusCode} ${res.headers['content-type']}`);
console.log(
  res.body
    .split('\r\n')
    .filter((l) => /^(DTSTART|SUMMARY|LOCATION|DESCRIPTION):/.test(l))
    .map((l) => `    ${l}`)
    .join('\n'),
);
await app.close();

console.log('\n== Splitter ==');
console.log(' ', await doers.splitter.send({ ...summary, idempotencyKey: `${plan.id}:splitter` }));
flush();

console.log('\n== Watcher (armed 45 min before; three passes) ==');
await doers.watcher.start(summary);
const ticks: Array<[number, Record<string, [number, number]>]> = [
  [-15, { user_ava: [0.004, 0], user_ben: [0.02, 0], user_chloe: [0.15, 0] }],
  [-5, { user_ava: [0, 0], user_ben: [0.006, 0], user_chloe: [0.14, 0] }],
  [-1, { user_ava: [0, 0], user_ben: [0, 0], user_chloe: [0.12, 0] }],
];
for (const [minsBefore, where] of ticks) {
  nowMs = START.getTime() + minsBefore * 60_000;
  for (const [id, [dLat, dLng]] of Object.entries(where)) {
    fixes.set(id, {
      lat: venue.location.lat + dLat,
      lng: venue.location.lng + dLng,
      capturedAt: null,
    });
    bubbles.locationCache.delete(id);
  }
  bubbles.prefetchSignals(Object.keys(where));
  await new Promise((r) => setTimeout(r, 30));
  console.log(`  t-${-minsBefore} min:`);
  await doers.watchTick(bookingId, plan.id);
  flush();
}
await doers.watcher.stop({ planId: plan.id });
rt.close();
