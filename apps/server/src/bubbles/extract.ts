/**
 * Fact extraction. Haiku turns free text into candidate facts (structured JSON, zod-validated);
 * deterministic code decides what gets saved, normalizes values, and resolves time phrases.
 * When Haiku is unavailable or slow, the rule extractor covers the common cases.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { FactType, NEVER_RELAX_FACT_TYPES } from '@bubbleworks/shared';
import { z } from 'zod';

export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

/** Hard facts filter candidates. Everything else only scores them. */
export const HARD_FACT_TYPES: ReadonlySet<FactType> = new Set<FactType>([
  ...NEVER_RELAX_FACT_TYPES,
  'budget_max',
  'diet',
]);

export const ExtractedFact = z.object({
  type: FactType,
  value: z.string(),
  confidence: z.number(),
  /** Time phrase that limits the fact ("till Friday"); code resolves it to a date. */
  until_phrase: z.string().nullable(),
});
export type ExtractedFact = z.infer<typeof ExtractedFact>;

export const Extraction = z.object({ facts: z.array(ExtractedFact) });

/** Which onboarding question the text answers, so the extractor reads "20" as a budget. */
export type ExtractHint =
  'diet_allergy' | 'budget' | 'neighborhood' | 'favorites' | 'venmo' | 'chat';

export interface FactExtractor {
  extract(text: string, hint: ExtractHint): Promise<ExtractedFact[]>;
}

const DIETS = ['vegetarian', 'vegan', 'pescatarian', 'gluten_free', 'dairy_free'] as const;
const ALLERGIES = ['peanut', 'tree_nut', 'shellfish', 'dairy', 'gluten', 'soy', 'egg', 'sesame'];
const RELIGIOUS = ['halal', 'kosher', 'hindu_veg', 'jain'];
const ACCESS = ['wheelchair', 'step_free', 'quiet'];

const SYSTEM = `You read one text message a person sent to their own dining assistant and list the dining facts it states about the sender.
Only facts about the sender. Never guess. If nothing applies, return an empty list.
Types and value formats:
- diet: one of ${DIETS.join(' | ')}
- allergy: one of ${ALLERGIES.join(' | ')}
- religious_diet: one of ${RELIGIOUS.join(' | ')}
- accessibility: one of ${ACCESS.join(' | ')}
- budget_max: integer dollars per person, e.g. "25" (for a range, the top of the range)
- cuisine_like / cuisine_avoid: lowercase cuisine key, e.g. "thai", "sushi", "pizza"
- neighborhood: the area name as written
- favorite_venue: the restaurant or place name as written
- venmo_handle: "@name"
- other: a short note for anything dining-related that fits nowhere else
until_phrase: copy the time phrase when the fact is temporary ("till Friday", "this week"), else null.
confidence: 0 to 1.`;

const HINTS: Record<ExtractHint, string> = {
  diet_allergy: 'The person was asked: diet or allergies?',
  budget: 'The person was asked: usual budget per person for dinner? A bare number is budget_max.',
  neighborhood:
    'The person was asked: what area are you usually in? Their answer is a neighborhood.',
  favorites: 'The person was asked: two favorite spots? Each place named is a favorite_venue.',
  venmo: 'The person was asked: Venmo handle? A bare handle is venmo_handle.',
  chat: 'This is a normal chat message.',
};

export class HaikuExtractor implements FactExtractor {
  private readonly client: Anthropic;

  constructor(
    options: { apiKey?: string; timeoutMs?: number } = {},
    private readonly fallback: FactExtractor = new RuleExtractor(),
  ) {
    this.client = new Anthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      timeout: options.timeoutMs ?? 8_000,
      maxRetries: 1,
    });
  }

  async extract(text: string, hint: ExtractHint): Promise<ExtractedFact[]> {
    try {
      const res = await this.client.messages.parse({
        model: HAIKU_MODEL,
        max_tokens: 512,
        system: SYSTEM,
        messages: [{ role: 'user', content: `${HINTS[hint]}\nMessage: ${text}` }],
        output_config: { format: zodOutputFormat(Extraction) },
      });
      return normalize(Extraction.parse(res.parsed_output).facts);
    } catch {
      return this.fallback.extract(text, hint);
    }
  }
}

/** Regex coverage for the common answers. Also the test double. */
export class RuleExtractor implements FactExtractor {
  async extract(text: string, hint: ExtractHint): Promise<ExtractedFact[]> {
    const t = text.toLowerCase();
    const out: ExtractedFact[] = [];
    const add = (type: FactType, value: string, until: string | null = null) =>
      out.push({ type, value, confidence: 0.7, until_phrase: until });

    if (/\bvegan\b/.test(t)) add('diet', 'vegan');
    else if (/\bvegetarian\b|\bveggie\b/.test(t)) add('diet', 'vegetarian');
    else if (/\bpescatarian\b/.test(t)) add('diet', 'pescatarian');
    if (/gluten[- ]free|celiac/.test(t)) add('diet', 'gluten_free');
    if (/dairy[- ]free|lactose/.test(t)) add('diet', 'dairy_free');

    const allergyCue = /allerg|can'?t (have|eat)|cannot (have|eat)/.test(t);
    if (allergyCue) {
      if (/peanut/.test(t)) add('allergy', 'peanut');
      if (/tree ?nut|almond|cashew|walnut|pecan/.test(t)) add('allergy', 'tree_nut');
      if (/shellfish|shrimp|crab|lobster/.test(t)) add('allergy', 'shellfish');
      if (/sesame/.test(t)) add('allergy', 'sesame');
      if (/\bsoy\b/.test(t)) add('allergy', 'soy');
      if (/\beggs?\b/.test(t)) add('allergy', 'egg');
    }
    if (/\bhalal\b/.test(t)) add('religious_diet', 'halal');
    if (/\bkosher\b/.test(t)) add('religious_diet', 'kosher');
    if (/wheelchair/.test(t)) add('accessibility', 'wheelchair');

    const until = /\b(till|until|thru|through)\s+([a-z]+(?:\s+[a-z]+)?)/.exec(t);
    const money = [...t.matchAll(/\$?\s?(\d{1,3})(?:\s?(?:-|to)\s?\$?(\d{1,3}))?/g)];
    if (money.length && (hint === 'budget' || /\$|budget|broke|under|max/.test(t))) {
      const m = money[money.length - 1]!;
      const top = Number(m[2] ?? m[1]);
      if (top > 0 && top < 500) add('budget_max', String(top), until ? until[0] : null);
    } else if (hint === 'budget' && /cheap|broke|tight/.test(t)) {
      add('budget_max', '15', until ? until[0] : null);
    }

    const venmo = /@([a-z0-9_-]{3,30})/.exec(t);
    if (venmo) add('venmo_handle', `@${venmo[1]}`);

    if (hint === 'neighborhood' && !isSkip(t)) add('neighborhood', text.trim());
    if (hint === 'favorites' && !isSkip(t)) {
      for (const name of splitList(text)) add('favorite_venue', name);
    }
    return out;
  }
}

/** Snap model output onto the repo's value conventions; drop anything that does not fit. */
export function normalize(input: ExtractedFact[]): ExtractedFact[] {
  const out: ExtractedFact[] = [];
  for (const f of input) {
    const v = f.value.trim();
    const key = v.toLowerCase().replace(/[\s-]+/g, '_');
    const conf = Math.min(1, Math.max(0, f.confidence));
    const keep = (value: string) => out.push({ ...f, value, confidence: conf });
    switch (f.type) {
      case 'diet':
        if ((DIETS as readonly string[]).includes(key)) keep(key);
        break;
      case 'allergy':
        if (ALLERGIES.includes(key)) keep(key);
        else if (key === 'peanuts') keep('peanut');
        else if (key === 'tree_nuts' || key === 'nuts') keep('tree_nut');
        else if (key === 'eggs') keep('egg');
        break;
      case 'religious_diet':
        if (RELIGIOUS.includes(key)) keep(key);
        break;
      case 'accessibility':
        if (ACCESS.includes(key)) keep(key);
        break;
      case 'budget_max': {
        const n = Number.parseInt(v.replace(/[^\d]/g, ''), 10);
        if (Number.isFinite(n) && n > 0 && n < 500) keep(String(n));
        break;
      }
      case 'cuisine_like':
      case 'cuisine_avoid':
        if (key) keep(key);
        break;
      case 'venmo_handle': {
        const h = v.replace(/^@?/, '@').replace(/\s+/g, '');
        if (/^@[A-Za-z0-9_-]{3,30}$/.test(h)) keep(h);
        break;
      }
      default:
        if (v) keep(v);
    }
  }
  return out;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Resolves a time phrase to the moment the fact expires, as an ISO instant. "till Friday" lasts
 * through the end of the next Friday (a Friday phrase said on a Friday means today). Unknown
 * phrases default to 7 days so a temporary limit never becomes permanent by accident.
 */
export function resolveUntil(phrase: string, now: Date, timeZone = 'America/New_York'): string {
  const p = phrase.toLowerCase();
  const local = localParts(now, timeZone);
  let addDays: number;
  const day = WEEKDAYS.findIndex((d) => p.includes(d) || p.includes(d.slice(0, 3)));
  if (day >= 0) addDays = (day - local.weekday + 7) % 7;
  else if (/tonight|today/.test(p)) addDays = 0;
  else if (/tomorrow/.test(p)) addDays = 1;
  else if (/weekend/.test(p)) addDays = (0 - local.weekday + 7) % 7;
  else if (/next week/.test(p)) addDays = 7 + ((6 - local.weekday + 7) % 7);
  else if (/(this )?week/.test(p)) addDays = (6 - local.weekday + 7) % 7;
  else if (/month/.test(p)) addDays = local.daysInMonth - local.day;
  else addDays = 7;
  return endOfLocalDay(now, addDays, timeZone).toISOString();
}

function localParts(
  d: Date,
  timeZone: string,
): { weekday: number; day: number; daysInMonth: number; y: number; m: number } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'long',
  }).formatToParts(d);
  const get = (t: string) => f.find((x) => x.type === t)?.value ?? '';
  const y = Number(get('year'));
  const m = Number(get('month'));
  return {
    weekday: WEEKDAYS.indexOf(get('weekday').toLowerCase()),
    day: Number(get('day')),
    daysInMonth: new Date(Date.UTC(y, m, 0)).getUTCDate(),
    y,
    m,
  };
}

/** 23:59:59 local time, `addDays` days after `now`'s local date. */
function endOfLocalDay(now: Date, addDays: number, timeZone: string): Date {
  const { y, m, day } = localParts(now, timeZone);
  const target = new Date(Date.UTC(y, m - 1, day + addDays, 23, 59, 59));
  // Shift from "that wall time in UTC" to "that wall time in timeZone".
  const asLocal = new Date(target.toLocaleString('en-US', { timeZone }));
  const asUtc = new Date(target.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(target.getTime() + (asUtc.getTime() - asLocal.getTime()));
}

export function isSkip(text: string): boolean {
  return /^\s*(skip|none|nope|no|n\/a|na|nothing|pass|nah|-)\s*[.!]*\s*$/i.test(text);
}

export function splitList(text: string): string[] {
  return text
    .split(/,|;|\n|\band\b|&/i)
    .map((s) => s.trim().replace(/^(the|my)\s+/i, ''))
    .filter((s) => s.length > 1);
}
