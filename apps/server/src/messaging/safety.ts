/**
 * Safety layer: no bubble reveals another person's constraint.
 *
 * Every inbound message passes this gate before the bubble (P3) or the engine (P1) sees it.
 * Messages that probe another person's private details ("what's Ben's budget?", "who's
 * allergic?", "is it because of Chloe?") get a friendly refusal and go no further. Rules decide
 * the clear cases; Haiku decides the rest. Questions about yourself, the whole group's plan, or
 * the restaurant pass through.
 *
 * Every refusal (and every pause, from the intake) is written to p2_audit.
 */
import type Database from 'better-sqlite3';
import type { CrewDirectory } from '@bubbleworks/shared';
import type { Logger } from '../events/bus.js';
import type { Classifier } from './classifier.js';

export const REFUSAL_TEXT =
  "I keep everyone's details private 🫧 Ask me what works for the whole group and I've got you.";

/** Private details a bubble holds: diet, allergies, religion, access, money, place, time. */
const SENSITIVE =
  /\b(budgets?|afford|money|broke|cheap(?:est)?|spend(?:ing)?|price limit|allerg\w*|diets?|dietary|vegetarian|vegan|pescatarian|halal|kosher|jain|gluten|dairy|lactose|peanuts?|nuts?|shellfish|religio\w*|wheelchair|accessib\w*|disab\w*|mobility|location|where (?:is|does|did|are|was)|lives?|home|address|schedule|calendar|busy|asleep|sleeping|driving|focus|can'?t eat|doesn'?t eat|don'?t eat|won'?t eat)\b/i;

/** Picking people out of the group. */
const PICKER =
  /\b(who|whose|which (?:one|of us|of you|person|people)|how many (?:of us|of you|people|ppl)|anyone|anybody|someone|somebody|everyone except)\b/i;

/** Blaming a named person for the outcome reveals their limit just as well. */
const BLAME = /\b(because of|reason|why|fault|blame|thanks to)\b/i;

/** The sender asking about themselves. */
const SELF = /\b(my|me|am i|i'?m|mine)\b/i;

export type ProbeVerdict = 'clean' | 'probe' | 'unclear';

export interface ProbeDecision {
  verdict: ProbeVerdict;
  reason: string;
}

/** Rules only. otherNames: first names of the sender's crewmates, lowercased. */
export function detectProbe(text: string, otherNames: string[]): ProbeDecision {
  const named = otherNames.find(
    (n) => n.length >= 2 && new RegExp(`\\b${escapeRegExp(n)}(?:'s|s)?\\b`, 'i').test(text),
  );
  const sensitive = SENSITIVE.test(text);
  if (named && sensitive) return { verdict: 'probe', reason: 'named person + private topic' };
  if (named && BLAME.test(text)) return { verdict: 'probe', reason: 'blames a named person' };
  if (!sensitive) return { verdict: 'clean', reason: 'no private topic' };
  if (PICKER.test(text)) return { verdict: 'probe', reason: 'picks people out on a private topic' };
  if (SELF.test(text)) return { verdict: 'clean', reason: 'about the sender' };
  return { verdict: 'unclear', reason: 'private topic, no target' };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type AuditKind = 'refusal' | 'pause' | 'resume' | 'cancel' | 'veto';

export class AuditLog {
  constructor(private readonly sqlite: Database.Database) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS p2_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        user_id TEXT NOT NULL,
        plan_id TEXT,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL
      );
    `);
  }

  /** detail never contains message text: reasons and ids only. */
  record(entry: {
    userId: string;
    planId?: string | null;
    kind: AuditKind;
    detail: Record<string, unknown>;
  }): void {
    this.sqlite
      .prepare('INSERT INTO p2_audit (at, user_id, plan_id, kind, detail) VALUES (?, ?, ?, ?, ?)')
      .run(
        new Date().toISOString(),
        entry.userId,
        entry.planId ?? null,
        entry.kind,
        JSON.stringify(entry.detail),
      );
  }

  list(kind?: AuditKind): Array<{
    userId: string;
    planId: string | null;
    kind: AuditKind;
    detail: Record<string, unknown>;
  }> {
    const rows = (
      kind
        ? this.sqlite.prepare('SELECT * FROM p2_audit WHERE kind = ? ORDER BY id').all(kind)
        : this.sqlite.prepare('SELECT * FROM p2_audit ORDER BY id').all()
    ) as Array<{ user_id: string; plan_id: string | null; kind: AuditKind; detail: string }>;
    return rows.map((r) => ({
      userId: r.user_id,
      planId: r.plan_id,
      kind: r.kind,
      detail: JSON.parse(r.detail) as Record<string, unknown>,
    }));
  }
}

export interface SafetyLayerOptions {
  port: {
    sendPrivateText(input: {
      userId: string;
      text: string;
      idempotencyKey: string;
    }): Promise<unknown>;
  };
  crews: Pick<CrewDirectory, 'crewsOf' | 'membersOf'>;
  classifier: Classifier | null;
  audit: AuditLog;
  log: Logger;
  /** Haiku must be at least this sure to refuse an unclear message. */
  minConfidence?: number;
}

export class SafetyLayer {
  constructor(private readonly o: SafetyLayerOptions) {}

  /** The inbound gate: true when the message was refused and must go no further. */
  async gate(m: { userId: string; messageId: string; text: string }): Promise<boolean> {
    const decision = await this.decide(m.userId, m.text);
    if (decision.verdict !== 'probe') return false;
    await this.o.port.sendPrivateText({
      userId: m.userId,
      text: REFUSAL_TEXT,
      idempotencyKey: `safety:${m.messageId}`,
    });
    this.o.audit.record({ userId: m.userId, kind: 'refusal', detail: { reason: decision.reason } });
    this.o.log.info({ userId: m.userId, reason: decision.reason }, 'probe refused');
    return true;
  }

  async decide(userId: string, text: string): Promise<ProbeDecision> {
    const rules = detectProbe(text, await this.otherNames(userId));
    if (rules.verdict !== 'unclear') return rules;
    const judgement = await this.o.classifier?.probe?.(text);
    if (judgement && judgement.isProbe && judgement.confidence >= (this.o.minConfidence ?? 0.7)) {
      return { verdict: 'probe', reason: 'haiku: probes someone else' };
    }
    return {
      verdict: 'clean',
      reason: judgement ? 'haiku: not a probe' : 'unclear, no classifier',
    };
  }

  private async otherNames(userId: string): Promise<string[]> {
    const names = new Set<string>();
    for (const crew of await this.o.crews.crewsOf(userId)) {
      for (const member of await this.o.crews.membersOf(crew.id)) {
        if (member.id === userId) continue;
        const first = member.displayName.trim().split(/\s+/)[0]?.toLowerCase();
        if (first) names.add(first);
      }
    }
    return [...names];
  }
}
