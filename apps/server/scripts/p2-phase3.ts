/**
 * P2 Phase 3 demo: every crew surface on a real plan record and the real EventBus.
 *
 *   pnpm p2:phase3           terminal provider
 *   pnpm p2:phase3 --real    the real line. LINE LOCK first. P2_PHASE1_PHONES = crew phones.
 *
 * Creates a plan in the database, renders the bundle (opt-out headcount), then publishes the
 * plan events the engine would (DELIBERATING, plan_locked, BOOKING, booking_confirmed) with a
 * real venue from data/venues.json, a few seconds apart. LiveSurfaces edits the headcount line
 * in place and sends the booked ticket image.
 */
import { crewChatId, type PlanEvent } from '@bubbleworks/shared';
import { DEMO_GROUP, PERSONAS } from '@bubbleworks/shared/fakes';
import { loadConfig } from '../src/config.js';
import type { Logger } from '../src/events/bus.js';
import { createMessaging, loadMessagingConfig } from '../src/messaging/index.js';
import { PhotonUsers } from '../src/messaging/photon-users.js';
import { createRuntime } from '../src/runtime.js';

const real = process.argv.includes('--real');
const stepMs = Number(process.env['P2_PHASE3_STEP_MS'] ?? 6000);

const log: Logger = {
  info: (obj, msg) => {
    if (msg && /live card|ticket|timing|message sent/.test(msg))
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
let organizerId = PERSONAS[0]!.id;
if (real) {
  const phones = (process.env['P2_PHASE1_PHONES'] ?? '').split(',').filter(Boolean);
  if (!phones.length) throw new Error('Set P2_PHASE1_PHONES to the crew phones');
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
      displayName: 'Pranav',
      handle: phone,
      bubbleNumber,
    });
    await runtime.crews.updateUser(user.id, { onboardedAt: new Date().toISOString() });
    ids.push(user.id);
  }
  let crew = await runtime.crews.createCrew({
    name: 'phase 3 crew',
    createdByUserId: ids[0]!,
    memberIds: ids,
  });
  for (const id of ids) crew = await runtime.crews.confirmMember(crew.id, id);
  crewId = crew.id;
  organizerId = ids[0]!;
}

const messaging = createMessaging({ config, runtime });
const chatId = crewChatId(crewId);
await messaging.start();

const venue = runtime.venues().find((v) => !v.isDemo && v.address) ?? runtime.venues()[0]!;
const backup =
  runtime.venues().find((v) => v.id !== venue.id && v.cuisine !== venue.cuisine) ?? null;
const plan = runtime.plans.create({
  groupId: crewId,
  chatId,
  createdByUserId: organizerId,
  intent: {
    meal: 'dinner',
    date: new Date().toISOString().slice(0, 10),
    startMinutes: 19 * 60 + 30,
    cuisine: null,
    rawText: 'dinner tonight?',
  },
});
const startAt = new Date(Date.now() + 2 * 3600_000).toISOString();
const pageVenue = (v: typeof venue) => ({ venueId: v.id, name: v.name, cuisine: v.cuisine });
const publish = (event: Record<string, unknown>) =>
  runtime.bus.publish({
    planId: plan.id,
    at: new Date().toISOString(),
    ...event,
  } as unknown as PlanEvent);
const pause = () => new Promise((r) => setTimeout(r, stepMs));

console.log(`plan ${plan.id}: venue ${venue.name}${backup ? `, backup ${backup.name}` : ''}`);
const intake = messaging.attachEngine({
  handleIntent: async () => ({ planId: plan.id, created: false }),
  handleVote: async () => undefined,
  handleHeadcount: async (h) => console.log(`engine: headcount ${h.userId} ${h.in ? 'IN' : 'OUT'}`),
  handleAskAnswer: async () => undefined,
  handleMemberChange: async () => undefined,
  handleCallResult: async () => undefined,
  handleCommand: async () => undefined,
});

console.log('1. bundle (opt-out headcount, no poll, live link)');
await intake.renderBundle({
  planId: plan.id,
  chatId,
  organizerName: 'Pranav',
  meal: 'dinner',
  cuisinePoll: null,
  headcount: {
    closesAt: new Date(Date.now() + 60_000).toISOString(),
    timezone: 'America/New_York',
    mode: 'opt_out',
  },
  pageUrl: 'https://photon.codes',
});
await pause();
console.log('2. deliberating');
await publish({ type: 'plan_state_changed', from: 'GATHERING', to: 'DELIBERATING' });
await pause();
console.log('3. locked');
runtime.handle.sqlite
  .prepare('UPDATE plans SET chosen_venue_id = ?, backup_venue_id = ? WHERE id = ?')
  .run(venue.id, backup?.id ?? null, plan.id);
await publish({
  type: 'plan_locked',
  venue: pageVenue(venue),
  backup: backup ? pageVenue(backup) : null,
  startAt,
  partySize: 4,
});
await pause();
console.log('4. calling');
await publish({ type: 'plan_state_changed', from: 'LOCKED', to: 'BOOKING' });
await pause();
console.log('5. booked');
await publish({
  type: 'booking_confirmed',
  bookingId: 'booking_demo',
  venue: pageVenue(venue),
  startAt,
  partySize: 4,
  reservationName: 'Pranav',
});
await new Promise((r) => setTimeout(r, 8000));
console.log('done');
await messaging.stop();
runtime.close();
process.exit(0);
