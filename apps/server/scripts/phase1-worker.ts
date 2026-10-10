/**
 * Worker for pnpm p1:phase1. Stage "fresh" seeds a database, runs a scripted plan through
 * DETECTED, GATHERING, DELIBERATING, DEADLOCK, LOCKED, PAUSED, BOOKING with real timers, then
 * prints READY_TO_KILL and idles so the parent can SIGKILL it mid-plan. Stage "resume" opens
 * the same database, finds the plan in flight, lets the pending timer fire, and finishes
 * BOOKED, DAY_OF, CLOSED, plus one CANCELLED and one FAILED plan for completeness.
 */
import { parseArgs } from 'node:util';
import type { PlanEvent } from '@bubbleworks/shared';
import { DEMO_GROUP } from '@bubbleworks/shared/fakes';
import { loadConfig } from '../src/config.js';
import type { Logger } from '../src/events/bus.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { DEMO_VENUE_ID } from '../src/venues/demo-venue.js';

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    stage: { type: 'string', default: 'fresh' },
  },
});
if (!values.db) throw new Error('--db required');

const t0 = Date.now();
const stamp = () => `+${String(Date.now() - t0).padStart(5, ' ')}ms`;
const say = (line: string) => console.log(`${stamp()}  ${line}`);

const log: Logger = {
  info: (o, msg) => {
    if (msg === 'plan transition')
      say(`TRANSITION ${o['from']} -> ${o['to']}${o['reason'] ? `  (${o['reason']})` : ''}`);
    else if (msg === 'timer fired') say(`TIMER FIRED ${o['kind']} (late ${o['lateMs']} ms)`);
    else if (msg === 'candidates built')
      say(`candidates: ${o['candidates']} usable, ${o['excluded']} excluded`);
  },
  warn: (o, msg) => {
    if (msg === 'illegal transition rejected')
      say(`REJECTED ${o['from']} -> ${o['to']}: ${o['reason']}`);
    else say(`warn: ${msg ?? ''} ${JSON.stringify(o)}`);
  },
  error: (o, msg) => say(`error: ${msg ?? ''} ${JSON.stringify(o)}`),
  debug: () => undefined,
};

const DEADLINES = { poll_ms: 1_200, private_ask_ms: 700, veto_window_ms: 900, call_ms: 2_500 };
const DAY_OF_MS = 600;

const config = loadConfig({ NODE_ENV: 'test', DEMO_MODE: 'true', SEED_ON_BOOT: 'false' });

function wire(rt: Runtime, onEvent: (e: PlanEvent) => void): void {
  rt.bus.subscribe('*', onEvent);
}

async function fresh(): Promise<void> {
  const rt = createRuntime(config, {
    dbPath: values.db!,
    log,
    seed: true,
    timers: { deadlines: DEADLINES, tickMs: 100 },
  });
  say(`seeded: ${JSON.stringify(rt.seed)}`);
  say(`VENUE COUNT ${rt.seed?.venues}`);

  const today = new Date().toISOString().slice(0, 10);
  const plan = rt.plans.create({
    groupId: 'group_demo',
    chatId: DEMO_GROUP.chatId,
    intent: {
      meal: 'dinner',
      date: today,
      startMinutes: 19 * 60,
      cuisine: null,
      rawText: 'dinner today?',
    },
    createdByUserId: 'user_ava',
    sourceMessageId: 'msg_demo_1',
    demoMode: true,
  });
  say(`plan ${plan.id} created (page token ${plan.pageToken})`);
  wire(rt, (e) => say(`  event #${e.seq} ${e.type}`));

  await rt.plans.transition(plan.id, 'DETECTED', { reason: 'intent: dinner today?' });
  await rt.plans.transition(plan.id, 'GATHERING', { reason: 'poll + headcount posted' });

  // An illegal jump, logged and rejected.
  const bad = await rt.plans.tryTransition(plan.id, 'BOOKED', { reason: 'skip ahead' });
  if (bad.ok) throw new Error('expected rejection');

  // Party size guard: nobody is in yet.
  const early = await rt.plans.tryTransition(plan.id, 'DELIBERATING', { reason: 'too early' });
  if (early.ok) throw new Error('expected party-size rejection');

  for (const [userId, name] of [
    ['user_ava', 'Ava'],
    ['user_ben', 'Ben'],
    ['user_chloe', 'Chloe'],
    ['user_dev', 'Dev'],
  ] as const) {
    rt.plans.upsertMember(plan.id, userId, 'in');
    await rt.bus.publish({
      type: 'bubble_joined',
      planId: plan.id,
      at: new Date().toISOString(),
      bubble: { userId, displayName: name, status: 'fits' },
    });
  }
  rt.plans.upsertMember(plan.id, 'user_eli', 'out');
  await rt.bus.publish({
    type: 'bubble_left',
    planId: plan.id,
    at: new Date().toISOString(),
    userId: 'user_eli',
    reason: 'out',
  });

  rt.timers.schedule({ planId: plan.id, kind: 'poll_deadline' });
  say(`poll deadline scheduled in ${DEADLINES.poll_ms} ms`);

  const done = new Promise<void>((resolve) => {
    rt.timers.on('poll_deadline', async (t) => {
      await rt.plans.transition(t.planId, 'DELIBERATING', { reason: 'poll closed' });
      const set = await rt.candidates.forGroup({
        groupId: 'group_demo',
        date: today,
        startMinutes: 19 * 60,
        memberIds: rt.plans
          .members(t.planId)
          .filter((m) => m.status === 'in')
          .map((m) => m.userId),
      });
      say(`candidates for the 4 in: ${set.venues.map((v) => v.name).join(', ')}`);
      // Stage a deadlock, resolved by a private ask that times out.
      await rt.plans.transition(t.planId, 'DEADLOCK', { reason: 'no venue fits every budget' });
      await rt.bus.publish({
        type: 'private_ask_sent',
        planId: t.planId,
        at: new Date().toISOString(),
        askId: 'ask_demo_1',
      });
      rt.timers.schedule({
        planId: t.planId,
        kind: 'ask_timeout',
        payload: { askId: 'ask_demo_1' },
      });
    });
    rt.timers.on('ask_timeout', async (t) => {
      await rt.bus.publish({
        type: 'private_ask_resolved',
        planId: t.planId,
        at: new Date().toISOString(),
        askId: String(t.payload['askId']),
        outcome: 'expired',
      });
      await rt.plans.transition(t.planId, 'DELIBERATING', {
        reason: 'ask expired, rerun with relaxed time',
      });
      const set = await rt.candidates.forGroup({
        groupId: 'group_demo',
        date: today,
        startMinutes: 19 * 60,
      });
      const winner = set.venues.find((v) => v.id === DEMO_VENUE_ID) ?? set.venues[0]!;
      const backup = set.venues.find((v) => v.id !== winner.id) ?? null;
      const startAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
      rt.plans.setChoice(t.planId, {
        chosenVenueId: winner.id,
        backupVenueId: backup?.id ?? null,
        startAt,
      });
      await rt.plans.transition(t.planId, 'LOCKED', { reason: `winner ${winner.name}` });
      await rt.bus.publish({
        type: 'plan_locked',
        planId: t.planId,
        at: new Date().toISOString(),
        venue: { venueId: winner.id, name: winner.name, cuisine: winner.cuisine },
        backup: backup ? { venueId: backup.id, name: backup.name, cuisine: backup.cuisine } : null,
        startAt,
        partySize: rt.plans.inCount(t.planId),
      });
      // "wait" then "resume" while locked.
      await rt.plans.transition(t.planId, 'PAUSED', { reason: 'command: wait' });
      const wrong = await rt.plans.tryTransition(t.planId, 'BOOKING', {
        reason: 'resume to wrong state',
      });
      if (wrong.ok) throw new Error('expected resume guard');
      await rt.plans.transition(t.planId, 'LOCKED', { reason: 'command: resume' });
      rt.timers.schedule({ planId: t.planId, kind: 'veto_window' });
      say(`veto window scheduled in ${DEADLINES.veto_window_ms} ms`);
    });
    rt.timers.on('veto_window', async (t) => {
      await rt.plans.transition(t.planId, 'BOOKING', { reason: 'veto window passed' });
      await rt.bus.publish({
        type: 'doer_status',
        planId: t.planId,
        at: new Date().toISOString(),
        doer: 'caller',
        state: 'started',
        detail: 'Dialing',
      });
      rt.timers.schedule({
        planId: t.planId,
        kind: 'call_timeout',
        payload: { bookingId: 'booking_demo_1' },
      });
      say(
        `call timeout scheduled in ${DEADLINES.call_ms} ms; plan is BOOKING with a pending timer`,
      );
      resolve();
    });
  });

  rt.timers.start();
  await done;
  console.log('READY_TO_KILL');
  // Idle until the parent kills us. The pending call_timeout must survive in SQLite.
  await new Promise(() => undefined);
}

async function resume(): Promise<void> {
  const rt = createRuntime(config, {
    dbPath: values.db!,
    log,
    seed: false,
    timers: { deadlines: DEADLINES, tickMs: 100 },
  });
  const active = rt.plans.findAllActive();
  say(
    `RESUMED ${active.length} plan(s) in flight: ${active.map((p) => `${p.id} ${p.state}`).join(', ')}`,
  );
  const plan = active[0];
  if (!plan) throw new Error('no plan to resume');
  const pending = rt.timers.pending(plan.id);
  for (const t of pending) {
    say(
      `pending timer ${t.kind} due ${t.fireAt - Date.now() >= 0 ? `in ${t.fireAt - Date.now()} ms` : `${Date.now() - t.fireAt} ms ago (fires on first tick)`}`,
    );
  }
  const before = await rt.bus.replay(plan.id);
  say(`replay has ${before.length} events, last seq ${before.at(-1)?.seq}`);
  wire(rt, (e) => say(`  event #${e.seq} ${e.type}`));

  const closed = new Promise<void>((resolve) => {
    rt.timers.on('call_timeout', async (t) => {
      const p = rt.plans.mustGet(t.planId);
      await rt.plans.transition(t.planId, 'BOOKED', { reason: 'call result: booked' });
      await rt.bus.publish({
        type: 'booking_confirmed',
        planId: t.planId,
        at: new Date().toISOString(),
        bookingId: String(t.payload['bookingId']),
        venue: { venueId: p.chosenVenueId!, name: 'The Demo Table', cuisine: 'american' },
        startAt: p.startAt!,
        partySize: rt.plans.inCount(t.planId),
        reservationName: 'Ava',
      });
      rt.timers.schedule({ planId: t.planId, kind: 'day_of', delayMs: DAY_OF_MS });
    });
    rt.timers.on('day_of', async (t) => {
      await rt.plans.transition(t.planId, 'DAY_OF', { reason: 'it is the day' });
      rt.timers.schedule({
        planId: t.planId,
        kind: 'custom',
        id: `${t.planId}:close`,
        delayMs: DAY_OF_MS,
        payload: { action: 'close' },
      });
    });
    rt.timers.on('custom', async (t) => {
      await rt.plans.transition(t.planId, 'CLOSED', { reason: 'dinner happened' });
      await rt.bus.publish({
        type: 'plan_closed',
        planId: t.planId,
        at: new Date().toISOString(),
        reason: 'completed',
      });
      resolve();
    });
  });
  rt.timers.start();
  await closed;

  const final = rt.plans.mustGet(plan.id);
  say(`plan ${final.id} is ${final.state}; page token expires ${final.pageTokenExpiresAt}`);
  const after = await rt.bus.replay(plan.id);
  say(`replay now has ${after.length} events in seq order: ${after.map((e) => e.seq).join(',')}`);
  const dead = await rt.plans.tryTransition(plan.id, 'BOOKING', { reason: 'poke a closed plan' });
  if (dead.ok) throw new Error('terminal state accepted a transition');

  // The two remaining terminal states.
  const today = new Date().toISOString().slice(0, 10);
  const intent = {
    meal: 'dinner' as const,
    date: today,
    startMinutes: null,
    cuisine: null,
    rawText: 'dinner?',
  };
  const c = rt.plans.create({
    groupId: 'group_demo',
    chatId: DEMO_GROUP.chatId,
    intent,
    createdByUserId: 'user_ben',
  });
  await rt.plans.transition(c.id, 'DETECTED');
  await rt.plans.transition(c.id, 'CANCELLED', { reason: 'command: cancel' });
  const f = rt.plans.create({
    groupId: 'group_demo',
    chatId: DEMO_GROUP.chatId,
    intent,
    createdByUserId: 'user_dev',
  });
  await rt.plans.transition(f.id, 'DETECTED');
  await rt.plans.transition(f.id, 'GATHERING');
  await rt.plans.transition(f.id, 'FAILED', { reason: 'messaging adapter down' });
  say(
    `active plans now: ${rt.plans.findAllActive().length}; pending timers: ${rt.timers.pending().length}`,
  );
  rt.close();
}

(values.stage === 'resume' ? resume() : fresh()).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
