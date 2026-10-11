/**
 * Demo bubbles on top of P1's persona seed (Ava, Ben, Chloe, Dev, Eli in group_demo). Owner: P3.
 * Idempotent: rows have fixed ids and insert-or-ignore, so it runs on every boot with
 * SEED_ON_BOOT=true.
 *
 * Adds: onboarding complete for each persona, a favorite venue each, and three weeks of ledger
 * history so the demo shows fairness: Ava and Ben have each paid once, Chloe has compromised
 * twice (her next concession costs more), Eli once, Dev never.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { bubbleState, facts, ledger, users, venues } from '../db/schema.js';

const PERSONAS = ['user_ava', 'user_ben', 'user_chloe', 'user_dev', 'user_eli'] as const;

const FAVORITES: Record<string, string> = {
  user_ava: 'Alpha Pie',
  user_ben: "Al's Burger Shack",
  user_chloe: 'Bonchon Chicken',
  user_eli: 'Italian Pizzeria III',
};

const HISTORY: Array<{
  plan: string;
  daysAgo: number;
  rows: Array<
    [
      user: (typeof PERSONAS)[number],
      kind: 'paid' | 'compromised' | 'got_preference' | 'organized',
      amount: number,
      note: string | null,
    ]
  >;
}> = [
  {
    plan: 'plan_hist_1',
    daysAgo: 20,
    rows: [
      ['user_ava', 'organized', 1, null],
      ['user_ava', 'paid', 100, 'Alpha Pie'],
      ['user_chloe', 'compromised', 2, 'accepted a concession'],
      ['user_ben', 'got_preference', 1, 'pizza'],
    ],
  },
  {
    plan: 'plan_hist_2',
    daysAgo: 13,
    rows: [
      ['user_ben', 'organized', 1, null],
      ['user_ben', 'paid', 160, "Al's Burger Shack"],
      ['user_eli', 'compromised', 1, 'top choice lost'],
      ['user_ben', 'got_preference', 1, 'american'],
    ],
  },
  {
    plan: 'plan_hist_3',
    daysAgo: 6,
    rows: [
      ['user_dev', 'organized', 1, null],
      ['user_chloe', 'compromised', 1, 'top choice lost'],
      ['user_dev', 'got_preference', 1, 'korean'],
    ],
  },
];

export interface DemoSeedResult {
  personas: number;
  favorites: number;
  ledgerRows: number;
}

export function seedDemoBubbles(db: Db, now: Date = new Date()): DemoSeedResult {
  const present = PERSONAS.filter((id) =>
    db.select({ id: users.id }).from(users).where(eq(users.id, id)).get(),
  );
  if (!present.length) return { personas: 0, favorites: 0, ledgerRows: 0 };
  const nowIso = now.toISOString();
  let favorites = 0;
  let ledgerRows = 0;

  db.transaction((tx) => {
    for (const id of present) {
      tx.insert(bubbleState)
        .values({
          userId: id,
          onboardingStep: null,
          onboardingStartedAt: nowIso,
          onboardingCompletedAt: nowIso,
          pending: null,
          updatedAt: nowIso,
        })
        .onConflictDoNothing()
        .run();
      const name = FAVORITES[id];
      const venue = name
        ? tx.select({ id: venues.id }).from(venues).where(eq(venues.name, name)).get()
        : undefined;
      if (venue) {
        favorites += tx
          .insert(facts)
          .values({
            id: `fact_seed_fav_${id}`,
            userId: id,
            type: 'favorite_venue',
            value: venue.id,
            hard: false,
            confidence: 1,
            source: 'onboarding',
            confirmed: true,
            expiresAt: null,
            createdAt: nowIso,
          })
          .onConflictDoNothing()
          .run().changes;
      }
    }
    for (const h of HISTORY) {
      const at = new Date(now.getTime() - h.daysAgo * 86_400_000).toISOString();
      for (const [userId, kind, amount, note] of h.rows) {
        if (!present.includes(userId)) continue;
        ledgerRows += tx
          .insert(ledger)
          .values({
            id: `ledger_seed_${h.plan}_${kind}_${userId}`,
            groupId: 'group_demo',
            planId: h.plan,
            userId,
            kind,
            amount,
            note,
            at,
          })
          .onConflictDoNothing()
          .run().changes;
      }
    }
  });
  return { personas: present.length, favorites, ledgerRows };
}
