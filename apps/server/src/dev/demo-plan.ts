/**
 * Demo plan driver for the live page (P4) and rehearsals. Creates a plan for the seeded crew,
 * moves it to GATHERING with bubble and candidate events, and steps it along the happy path
 * one state at a time, publishing the page event each state implies. Deterministic, no timers,
 * no messaging: the real engine (Phase 2) owns the production flow.
 */
import type { PageVenue, Plan, PlanState, Venue } from '@bubbleworks/shared';
import { PERSONAS } from '@bubbleworks/shared/fakes';
import type { Runtime } from '../runtime.js';
import { DEMO_VENUE_ID } from '../venues/demo-venue.js';

const IN = ['user_ava', 'user_ben', 'user_chloe', 'user_dev'] as const;
const OUT = ['user_eli'] as const;

export const HAPPY_PATH: readonly PlanState[] = [
  'DELIBERATING',
  'LOCKED',
  'BOOKING',
  'BOOKED',
  'DAY_OF',
  'CLOSED',
];

function pageVenue(v: Venue): PageVenue {
  return { venueId: v.id, name: v.name, cuisine: v.cuisine };
}

function nameOf(userId: string): string {
  return PERSONAS.find((p) => p.id === userId)?.displayName ?? userId;
}

export interface DemoPlanResult {
  plan: Plan;
  candidates: Venue[];
  eventsPublished: number;
}

/** Create a demo plan in GATHERING: four in, one out, top candidates announced. */
export async function createDemoPlan(rt: Runtime, now = new Date()): Promise<DemoPlanResult> {
  const today = now.toISOString().slice(0, 10);
  const plan = rt.plans.create({
    groupId: 'group_demo',
    chatId: 'crew:group_demo',
    intent: {
      meal: 'dinner',
      date: today,
      startMinutes: 19 * 60,
      cuisine: null,
      rawText: 'dinner tonight? (demo)',
    },
    createdByUserId: 'user_ava',
    demoMode: true,
  });
  let events = 0;
  await rt.plans.transition(plan.id, 'DETECTED', { reason: 'demo: intent' });
  await rt.plans.transition(plan.id, 'GATHERING', { reason: 'demo: bundle posted' });
  events += 2;
  const at = () => new Date().toISOString();
  for (const userId of IN) {
    rt.plans.upsertMember(plan.id, userId, 'in');
    await rt.bus.publish({
      type: 'bubble_joined',
      planId: plan.id,
      at: at(),
      bubble: { userId, displayName: nameOf(userId), status: 'fits' },
    });
    events += 1;
  }
  for (const userId of OUT) {
    rt.plans.upsertMember(plan.id, userId, 'out');
    await rt.bus.publish({ type: 'bubble_left', planId: plan.id, at: at(), userId, reason: 'out' });
    events += 1;
  }
  const set = await rt.candidates.forGroup({
    groupId: 'group_demo',
    date: today,
    startMinutes: 19 * 60,
    memberIds: [...IN],
  });
  const demo = set.venues.find((v) => v.id === DEMO_VENUE_ID);
  const others = set.venues.filter((v) => v.id !== DEMO_VENUE_ID).slice(0, 4);
  const candidates = demo ? [demo, ...others] : others;
  for (const v of candidates) {
    await rt.bus.publish({
      type: 'candidate_added',
      planId: plan.id,
      at: at(),
      venue: pageVenue(v),
    });
    events += 1;
  }
  return { plan: rt.plans.mustGet(plan.id), candidates, eventsPublished: events };
}

/** Advance one state along the happy path, publishing what the page expects to see. */
export async function stepDemoPlan(
  rt: Runtime,
  planId: string,
): Promise<{ plan: Plan; eventsPublished: number }> {
  const plan = rt.plans.mustGet(planId);
  const idx = HAPPY_PATH.indexOf(plan.state);
  const next: PlanState | undefined =
    plan.state === 'GATHERING' ? HAPPY_PATH[0] : HAPPY_PATH[idx + 1];
  if (!next) throw new Error(`plan ${planId} is ${plan.state}; nothing to step to`);
  const at = () => new Date().toISOString();
  const members = rt.plans.members(planId).filter((m) => m.status === 'in');
  const bubbles = members.map((m) => ({
    userId: m.userId,
    displayName: nameOf(m.userId),
    status: 'fits' as const,
  }));
  const set = await rt.candidates.forGroup({
    groupId: plan.groupId,
    date: plan.intent.date,
    startMinutes: plan.intent.startMinutes,
    memberIds: members.map((m) => m.userId),
  });
  const winner = set.venues.find((v) => v.id === DEMO_VENUE_ID) ?? set.venues[0];
  const backup = set.venues.find((v) => v.id !== winner?.id) ?? null;
  if (!winner) throw new Error('no candidates for the demo crew');
  let events = 0;

  switch (next) {
    case 'DELIBERATING': {
      await rt.plans.transition(planId, next, { reason: 'demo: poll closed' });
      const pool = [winner, ...set.venues.filter((v) => v.id !== winner.id).slice(0, 4)];
      for (let round = 1; round <= 2; round += 1) {
        const scores = members.flatMap((m, mi) =>
          pool.map((v, vi) => ({
            userId: m.userId,
            venueId: v.id,
            score: Math.max(0, Math.min(1, 0.9 - vi * 0.15 - (mi % 2) * 0.1 + round * 0.02)),
          })),
        );
        await rt.bus.publish({
          type: 'round_complete',
          planId,
          at: at(),
          round,
          scores,
          bubbles,
          leaderVenueId: winner.id,
        });
        const loser = pool.at(-1);
        if (loser && pool.length > 2) {
          await rt.bus.publish({
            type: 'candidate_eliminated',
            planId,
            at: at(),
            venueId: loser.id,
            round,
            reason: 'least_support',
          });
          pool.pop();
          events += 1;
        }
        events += 1;
      }
      await rt.bus.publish({
        type: 'bubble_merged',
        planId,
        at: at(),
        userIds: members.map((m) => m.userId),
        venueId: winner.id,
      });
      events += 2;
      break;
    }
    case 'LOCKED': {
      const startAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
      rt.plans.setChoice(planId, {
        chosenVenueId: winner.id,
        backupVenueId: backup?.id ?? null,
        startAt,
      });
      await rt.plans.transition(planId, next, { reason: `demo: winner ${winner.name}` });
      await rt.bus.publish({
        type: 'plan_locked',
        planId,
        at: at(),
        venue: pageVenue(winner),
        backup: backup ? pageVenue(backup) : null,
        startAt,
        partySize: members.length,
      });
      events += 2;
      break;
    }
    case 'BOOKING': {
      await rt.plans.transition(planId, next, { reason: 'demo: veto window passed' });
      await rt.bus.publish({
        type: 'doer_status',
        planId,
        at: at(),
        doer: 'caller',
        state: 'started',
        detail: 'Dialing',
      });
      events += 2;
      break;
    }
    case 'BOOKED': {
      await rt.plans.transition(planId, next, { reason: 'demo: call result booked' });
      await rt.bus.publish({
        type: 'doer_status',
        planId,
        at: at(),
        doer: 'caller',
        state: 'done',
        detail: 'Booked',
      });
      await rt.bus.publish({
        type: 'booking_confirmed',
        planId,
        at: at(),
        bookingId: `booking_demo_${planId.slice(-6)}`,
        venue: pageVenue(winner),
        startAt: plan.startAt ?? at(),
        partySize: members.length,
        reservationName: nameOf(plan.createdByUserId),
      });
      for (const doer of ['inviter', 'splitter', 'watcher'] as const) {
        await rt.bus.publish({
          type: 'doer_status',
          planId,
          at: at(),
          doer,
          state: doer === 'watcher' ? 'working' : 'done',
        });
        events += 1;
      }
      events += 3;
      break;
    }
    case 'DAY_OF': {
      await rt.plans.transition(planId, next, { reason: 'demo: day of' });
      events += 1;
      break;
    }
    case 'CLOSED': {
      await rt.plans.transition(planId, next, { reason: 'demo: dinner happened' });
      await rt.bus.publish({
        type: 'doer_status',
        planId,
        at: at(),
        doer: 'watcher',
        state: 'done',
      });
      await rt.bus.publish({ type: 'plan_closed', planId, at: at(), reason: 'completed' });
      events += 3;
      break;
    }
    default:
      throw new Error(`unexpected next state ${String(next)}`);
  }
  return { plan: rt.plans.mustGet(planId), eventsPublished: events };
}
