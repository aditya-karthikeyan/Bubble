/**
 * Facts store: what a bubble knows about its person. Owner: P3.
 *
 * Merge rules (deterministic, never decided by an LLM):
 * - Single-valued types (budget_max, neighborhood, venmo_handle): a newer fact replaces the older
 *   one with the same lifetime. A temporary fact (expiresAt set) never deletes a permanent one;
 *   the active value is the newest unexpired fact.
 * - diet: a newer diet replaces the older one.
 * - Every other type is multi-valued: the same (type, value) is updated in place, not duplicated.
 * - cuisine_like and cuisine_avoid on the same cuisine cancel: the newer one wins.
 *
 * Profiles are cached in memory and rebuilt on every write for that user.
 */
import { and, desc, eq, isNull, or, gt, inArray } from 'drizzle-orm';
import {
  Fact as FactSchema,
  NewFact as NewFactSchema,
  newId,
  type Fact,
  type FactType,
  type NewFact,
} from '@bubbleworks/shared';
import type { Db } from '../db/client.js';
import { facts } from '../db/schema.js';

const SINGLE_VALUED: ReadonlySet<FactType> = new Set<FactType>([
  'budget_max',
  'neighborhood',
  'venmo_handle',
  'diet',
]);

const OPPOSITE: Partial<Record<FactType, FactType>> = {
  cuisine_like: 'cuisine_avoid',
  cuisine_avoid: 'cuisine_like',
};

export class FactStore {
  private readonly cache = new Map<string, Fact[]>();

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Active facts: unexpired, newest first. Cached per user. */
  active(userId: string): Fact[] {
    const hit = this.cache.get(userId);
    if (hit) return hit.filter((f) => !this.expired(f));
    const rows = this.db
      .select()
      .from(facts)
      .where(eq(facts.userId, userId))
      .orderBy(desc(facts.createdAt), desc(facts.id))
      .all()
      .map((r) => FactSchema.parse(r));
    this.cache.set(userId, rows);
    return rows.filter((f) => !this.expired(f));
  }

  /** For single-valued types, the newest active value; budget_max picks the newest unexpired. */
  current(userId: string, type: FactType): Fact | null {
    return this.active(userId).find((f) => f.type === type) ?? null;
  }

  get(factId: string): Fact | null {
    const row = this.db.select().from(facts).where(eq(facts.id, factId)).get();
    return row ? FactSchema.parse(row) : null;
  }

  record(input: NewFact): Fact {
    const fact = NewFactSchema.parse(input);
    const nowIso = this.now().toISOString();
    const saved = this.db.transaction((tx) => {
      const existing = tx.select().from(facts).where(eq(facts.userId, fact.userId)).all();

      if (SINGLE_VALUED.has(fact.type)) {
        const temporary = fact.expiresAt !== null;
        const replaced = existing.filter(
          (f) => f.type === fact.type && (f.expiresAt !== null) === temporary,
        );
        if (replaced.length) {
          tx.delete(facts)
            .where(
              inArray(
                facts.id,
                replaced.map((f) => f.id),
              ),
            )
            .run();
        }
      } else {
        const same = existing.find((f) => f.type === fact.type && f.value === fact.value);
        if (same) {
          // Keep the strongest evidence: confirmation and confidence never go down on a repeat.
          const patch = {
            hard: fact.hard,
            confidence: Math.max(same.confidence, fact.confidence),
            source: fact.source,
            confirmed: same.confirmed || fact.confirmed,
            expiresAt: fact.expiresAt,
            createdAt: nowIso,
          };
          tx.update(facts).set(patch).where(eq(facts.id, same.id)).run();
          return FactSchema.parse({ ...same, ...patch });
        }
        const opposite = OPPOSITE[fact.type];
        if (opposite) {
          tx.delete(facts)
            .where(
              and(
                eq(facts.userId, fact.userId),
                eq(facts.type, opposite),
                eq(facts.value, fact.value),
              ),
            )
            .run();
        }
      }

      const row = { ...fact, id: newId('fact'), createdAt: nowIso };
      tx.insert(facts).values(row).run();
      return FactSchema.parse(row);
    });
    this.cache.delete(fact.userId);
    return saved;
  }

  confirm(factIds: string[]): void {
    if (!factIds.length) return;
    const owners = this.ownersOf(factIds);
    this.db.update(facts).set({ confirmed: true }).where(inArray(facts.id, factIds)).run();
    for (const u of owners) this.cache.delete(u);
  }

  delete(factIds: string[]): void {
    if (!factIds.length) return;
    const owners = this.ownersOf(factIds);
    this.db.delete(facts).where(inArray(facts.id, factIds)).run();
    for (const u of owners) this.cache.delete(u);
  }

  /** "forget that": deletes and returns the most recently written fact, or null. */
  deleteLatest(userId: string): Fact | null {
    const row = this.db
      .select()
      .from(facts)
      .where(
        and(
          eq(facts.userId, userId),
          or(isNull(facts.expiresAt), gt(facts.expiresAt, this.now().toISOString())),
        ),
      )
      .orderBy(desc(facts.createdAt), desc(facts.id))
      .limit(1)
      .get();
    if (!row) return null;
    this.delete([row.id]);
    return FactSchema.parse(row);
  }

  /** Drop the cache for a user whose rows were removed outside this store. */
  evict(userId: string): void {
    this.cache.delete(userId);
  }

  private expired(f: Fact): boolean {
    return f.expiresAt !== null && Date.parse(f.expiresAt) <= this.now().getTime();
  }

  private ownersOf(factIds: string[]): string[] {
    return this.db
      .select({ userId: facts.userId })
      .from(facts)
      .where(inArray(facts.id, factIds))
      .all()
      .map((r) => r.userId);
  }
}

/** Short, human description of a fact for the person's own DM. Never sent to anyone else. */
export function describeFact(f: Pick<Fact, 'type' | 'value'>): string {
  const v = f.value.replace(/_/g, ' ');
  switch (f.type) {
    case 'diet':
      return `you eat ${v}`;
    case 'allergy':
      return `you're allergic to ${v}`;
    case 'religious_diet':
      return `you keep ${v}`;
    case 'accessibility':
      return `you need ${v === 'quiet' ? 'a quiet place' : `${v} access`}`;
    case 'budget_max':
      return `your budget is up to $${f.value} a person`;
    case 'cuisine_like':
      return `you like ${v}`;
    case 'cuisine_avoid':
      return `you'd rather skip ${v}`;
    case 'neighborhood':
      return `you're usually around ${f.value}`;
    case 'favorite_venue':
      return `one of your spots is ${f.value}`;
    case 'venmo_handle':
      return `your Venmo is ${f.value}`;
    case 'other':
      return f.value;
  }
}
