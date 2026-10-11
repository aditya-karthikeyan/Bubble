/**
 * Demo reset: clear every plan and everything hanging off plans, restore the seeded fairness
 * ledger, keep people, facts, crews, and venues. Used by pnpm demo:reset and the dev route so a
 * rehearsal starts from the same place every time.
 */
import { inArray, sql } from 'drizzle-orm';
import { newId } from '@bubbleworks/shared';
import type { Db } from '../db/client.js';
import {
  asks,
  audit,
  bookings,
  events,
  ledger,
  planMembers,
  plans,
  timers,
  votes,
} from '../db/schema.js';

/** Seeded history so fairness weighting has a story on day one: Ava and Chloe have given before. */
export const SEED_LEDGER: Array<{
  userId: string;
  kind: 'compromised' | 'got_preference' | 'organized' | 'paid';
  amount: number;
  note: string;
}> = [
  { userId: 'user_ava', kind: 'compromised', amount: 1, note: 'stretched budget +$5 (seed)' },
  { userId: 'user_ava', kind: 'organized', amount: 1, note: 'organized last time (seed)' },
  { userId: 'user_chloe', kind: 'compromised', amount: 2, note: 'walked further (seed)' },
  { userId: 'user_dev', kind: 'got_preference', amount: 1, note: 'got ramen (seed)' },
  { userId: 'user_ben', kind: 'paid', amount: 86, note: 'paid the table (seed)' },
];

export interface ResetResult {
  plans: number;
  events: number;
  timers: number;
  ledgerRestored: number;
  otherTables: string[];
}

/** Tables other roles create with CREATE TABLE IF NOT EXISTS that hold per-plan state. */
const OTHER_PLAN_TABLES = [
  'p2_messages',
  'p2_bundles',
  'p2_polls',
  'p4_calls',
  'doer_state',
  'doer_jobs',
];

export function demoReset(db: Db, groupId = 'group_demo'): ResetResult {
  return db.transaction((tx) => {
    const planIds = tx
      .select({ id: plans.id })
      .from(plans)
      .all()
      .map((r) => r.id);
    const eventCount =
      tx
        .select({ n: sql<number>`count(*)` })
        .from(events)
        .get()?.n ?? 0;
    const timerCount =
      tx
        .select({ n: sql<number>`count(*)` })
        .from(timers)
        .get()?.n ?? 0;
    if (planIds.length) {
      tx.delete(votes).where(inArray(votes.planId, planIds)).run();
      tx.delete(asks).where(inArray(asks.planId, planIds)).run();
      tx.delete(bookings).where(inArray(bookings.planId, planIds)).run();
      tx.delete(planMembers).where(inArray(planMembers.planId, planIds)).run();
    }
    tx.delete(events).run();
    tx.delete(timers).run();
    tx.delete(audit).run();
    tx.delete(plans).run();
    tx.delete(ledger).run();
    const at = new Date().toISOString();
    for (const row of SEED_LEDGER) {
      tx.insert(ledger)
        .values({
          id: newId('ledger'),
          groupId,
          planId: 'plan_seed',
          userId: row.userId,
          kind: row.kind,
          amount: row.amount,
          note: row.note,
          at,
        })
        .run();
    }
    const cleared: string[] = [];
    for (const t of OTHER_PLAN_TABLES) {
      const exists = tx.get<{ n: number }>(
        sql`select count(*) as n from sqlite_master where type = 'table' and name = ${t}`,
      );
      if (exists?.n) {
        tx.run(sql.raw(`delete from "${t}"`));
        cleared.push(t);
      }
    }
    return {
      plans: planIds.length,
      events: eventCount,
      timers: timerCount,
      ledgerRestored: SEED_LEDGER.length,
      otherTables: cleared,
    };
  });
}
