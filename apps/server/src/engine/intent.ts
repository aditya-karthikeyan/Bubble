/**
 * Rules-based intent parsing. P2's detector decides *whether* a message is a plan; this decides
 * *what* the plan is: meal, local date, requested time, named cuisine. Deterministic, no LLM.
 */
import type { IsoDate, MealKind, PlanIntent } from '@bubbleworks/shared';

const MEALS: Array<[RegExp, MealKind]> = [
  [/\b(breakfast|bfast)\b/i, 'breakfast'],
  [/\bbrunch\b/i, 'brunch'],
  [/\blunch\b/i, 'lunch'],
  [/\b(dinner|dins|supper|eat tonight|food tonight)\b/i, 'dinner'],
  [/\b(drinks?|beers?|bar)\b/i, 'drinks'],
  [/\b(coffee|cafe|boba|tea)\b/i, 'coffee'],
];

/** Cuisine words people type, folded to the venue cuisine keys in data/venues.json. */
const CUISINES: Array<[RegExp, string]> = [
  [/\b(pizza|pizzas|slice)\b/i, 'pizza'],
  [/\b(indian|curry)\b/i, 'indian'],
  [/\b(thai)\b/i, 'thai'],
  [/\b(mexican|tacos?|burritos?)\b/i, 'mexican'],
  [/\b(burgers?|american|wings|bbq)\b/i, 'american'],
  [/\b(sushi|japanese)\b/i, 'sushi'],
  [/\b(ramen|noodles?)\b/i, 'ramen'],
  [/\b(korean|kbbq)\b/i, 'korean'],
  [/\b(chinese|dim ?sum)\b/i, 'chinese'],
  [/\b(greek|mediterranean|med|gyro|kebab|shawarma)\b/i, 'mediterranean'],
  [/\b(italian|pasta)\b/i, 'italian'],
  [/\b(salad|healthy|bowls?)\b/i, 'healthy'],
  [/\b(sandwich|sandwiches|subs?|wraps?)\b/i, 'sandwich'],
];

export interface ParseIntentOptions {
  now: Date;
  timezone: string;
}

export function localDate(now: Date, timezone: string, dayOffset = 0): IsoDate {
  const shifted = new Date(now.getTime() + dayOffset * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(shifted);
}

export function parseTime(text: string): number | null {
  const m = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/i.exec(text);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase().replace(/\./g, '');
  if (hour > 23 || minute > 59) return null;
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  // "at 7" without am/pm means evening for dinner plans.
  if (!ampm && hour >= 1 && hour <= 11 && !/\b(breakfast|brunch|morning)\b/i.test(text)) hour += 12;
  // Reject bare numbers that are clearly not times ("table for 4", "2 people").
  if (
    !ampm &&
    !m[2] &&
    !/\bat\s+\d/i.test(m[0]) &&
    !/\b(at|around|@)\s*$/.test(text.slice(0, m.index))
  )
    return null;
  return hour * 60 + minute;
}

export function parseIntent(text: string, options: ParseIntentOptions): PlanIntent {
  const meal = MEALS.find(([re]) => re.test(text))?.[1] ?? 'dinner';
  const dayOffset = /\b(tomorrow|tmrw|tmr)\b/i.test(text) ? 1 : 0;
  const date = localDate(options.now, options.timezone, dayOffset);
  const cuisine = CUISINES.find(([re]) => re.test(text))?.[1] ?? null;
  return { meal, date, startMinutes: parseTime(text), cuisine, rawText: text };
}

/** Plan commands typed in a DM. Null when the text is not a command. */
export function parseCommand(text: string): 'wait' | 'resume' | 'cancel' | 'veto' | 'why' | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '');
  if (/^(wait|hold on|pause|hold)$/.test(t)) return 'wait';
  if (/^(resume|go ahead|continue|unpause|go)$/.test(t)) return 'resume';
  if (/^(cancel|cancel (the )?plan|nevermind|never mind|forget the plan|call it off)$/.test(t))
    return 'cancel';
  if (/^(veto|not there|no not there|somewhere else|different place)$/.test(t)) return 'veto';
  if (/^(why|why there|why that|explain|how come)\??$/.test(t)) return 'why';
  return null;
}
