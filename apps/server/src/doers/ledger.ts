/**
 * Fairness ledger updates after each booked plan. Owner: P3 (P1 reads it for scoring).
 *
 * On booking_confirmed, one row per member per outcome, idempotent per (kind, plan, user):
 * - compromised: accepted a concession ask (amount = concession cost), or voted and the winning
 *   cuisine was not among their choices (amount 1).
 * - got_preference: voted and the winner was among their choices.
 * - organized: started the plan.
 * - absent: represented by their bubble.
 * The Splitter writes `paid` for the payer. getProfile().recentCompromiseCount counts
 * `compromised` rows from the last 30 days, which raises that member's concession cost next time.
 */
import { and, eq } from 'drizzle-orm';
import type { EventBus, LedgerKind, PlanEvent } from '@bubbleworks/shared';
import type { Db } from '../db/client.js';
import { asks, ledger, planMembers, plans, venues, votes } from '../db/schema.js';
import { silentLogger, type Logger } from '../events/bus.js';

export interface LedgerRow {
  userId: string;
  kind: LedgerKind;
  amount: number;
  note: string | null;
}

export class LedgerWriter {
  constructor(
    private readonly db: Db,
    private readonly options: { now?: () => Date; log?: Logger } = {},
  ) {}

  attach(bus: EventBus): void {
    bus.subscribe('*', async (e: PlanEvent) => {
      if (e.type === 'booking_confirmed') this.recordPlan(e.planId);
    });
  }

  /** Writes the plan's outcome rows. Safe to call more than once. Returns what it wrote. */
  recordPlan(planId: string): LedgerRow[] {
    const plan = this.db.select().from(plans).where(eq(plans.id, planId)).get();
    if (!plan?.chosenVenueId) return [];
    const venue = this.db.select().from(venues).where(eq(venues.id, plan.chosenVenueId)).get();
    const winner = venue?.cuisine ?? null;
    const members = this.db
      .select()
      .from(planMembers)
      .where(eq(planMembers.planId, planId))
      .all()
      .filter((m) => m.status === 'in' || m.status === 'represented');

    const rows: LedgerRow[] = [];
    for (const m of members) {
      if (m.status === 'represented') {
        rows.push({ userId: m.userId, kind: 'absent', amount: 1, note: null });
      }
      if (m.userId === plan.createdByUserId) {
        rows.push({ userId: m.userId, kind: 'organized', amount: 1, note: null });
      }
      const accepted = this.db
        .select()
        .from(asks)
        .where(and(eq(asks.planId, planId), eq(asks.userId, m.userId), eq(asks.status, 'accepted')))
        .all();
      const conceded = accepted.reduce((n, a) => n + (a.concession?.cost ?? 1), 0);
      const choices = this.db
        .select({ choice: votes.choice })
        .from(votes)
        .where(and(eq(votes.planId, planId), eq(votes.userId, m.userId), eq(votes.kind, 'cuisine')))
        .all()
        .map((v) => v.choice);
      const lost = winner !== null && choices.length > 0 && !choices.includes(winner);
      if (conceded > 0 || lost) {
        rows.push({
          userId: m.userId,
          kind: 'compromised',
          amount: conceded + (lost ? 1 : 0),
          note: [conceded ? 'accepted a concession' : null, lost ? 'top choice lost' : null]
            .filter(Boolean)
            .join('; '),
        });
      } else if (winner !== null && choices.includes(winner)) {
        rows.push({ userId: m.userId, kind: 'got_preference', amount: 1, note: winner });
      }
    }

    const at = (this.options.now ?? (() => new Date()))().toISOString();
    for (const r of rows) {
      this.db
        .insert(ledger)
        .values({
          id: `ledger_${r.kind}_${planId}_${r.userId}`,
          groupId: plan.groupId,
          planId,
          userId: r.userId,
          kind: r.kind,
          amount: r.amount,
          note: r.note,
          at,
        })
        .onConflictDoNothing()
        .run();
    }
    (this.options.log ?? silentLogger).info(
      {
        planId,
        rows: rows.length,
        compromised: rows.filter((r) => r.kind === 'compromised').length,
      },
      'ledger updated',
    );
    return rows;
  }

  /** Per-user counts for a crew, for the demo and scoring. */
  summary(
    groupId: string,
  ): Array<{ userId: string; paid: number; compromised: number; got: number }> {
    const rows = this.db.select().from(ledger).where(eq(ledger.groupId, groupId)).all();
    const by = new Map<
      string,
      { userId: string; paid: number; compromised: number; got: number }
    >();
    for (const r of rows) {
      const s = by.get(r.userId) ?? { userId: r.userId, paid: 0, compromised: 0, got: 0 };
      if (r.kind === 'paid') s.paid++;
      if (r.kind === 'compromised') s.compromised++;
      if (r.kind === 'got_preference') s.got++;
      by.set(r.userId, s);
    }
    return [...by.values()].sort((a, b) => a.userId.localeCompare(b.userId));
  }
}
