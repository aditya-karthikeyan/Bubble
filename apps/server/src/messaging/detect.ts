/**
 * Rules-first plan detection and RSVP parsing. Pure functions, no I/O, run on every inbound
 * text. Rules settle the clear cases instantly; only "weak" detections and "unclear" RSVPs go
 * to Haiku (classifier.ts).
 */
import type { MealKind } from '@bubbleworks/shared';

export type DetectionLevel = 'none' | 'weak' | 'strong';

export interface Detection {
  level: DetectionLevel;
  meal: MealKind | null;
  /** 0 = today, 1 = tomorrow. */
  dayOffset: 0 | 1;
  /** Requested start, local minutes since midnight, when the text names a time. */
  startMinutes: number | null;
}

const MEALS: Array<[RegExp, MealKind]> = [
  [/\bbreakfast\b/i, 'breakfast'],
  [/\bbrunch\b/i, 'brunch'],
  [/\blunch\b/i, 'lunch'],
  [/\b(dinner|supper)\b/i, 'dinner'],
  [/\b(drinks?|beers?)\b/i, 'drinks'],
  [/\bcoffee\b/i, 'coffee'],
];

/** The role prompt's keyword gate, plus the meal words. */
const KEYWORDS =
  /\b(dinner|supper|lunch|brunch|breakfast|eat|food|hungry|grab|tonight|drinks?|coffee)\b/i;

/** Signals that someone is proposing, not reporting. */
const PROPOSAL =
  /\?|\b(anyone|anybody|wanna|want to|let'?s|lets|down for|who'?s|should we|we should|plans?|today|tonight|tomorrow)\b/i;

/** Reporting the past or declining: needs a second opinion. */
const HEDGE = /\b(already|just ate|had|ate|earlier|yesterday|last night|no thanks)\b/i;

const TIME =
  /\b(?:at|around|by|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b|\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;

export function parseStartMinutes(text: string, meal: MealKind | null): number | null {
  const m = TIME.exec(text);
  if (!m) return null;
  const hour = Number(m[1] ?? m[4]);
  const minute = Number(m[2] ?? m[5] ?? 0);
  const suffix = (m[3] ?? m[6])?.toLowerCase();
  if (hour > 23 || minute > 59) return null;
  let h = hour;
  if (suffix === 'pm' && h < 12) h += 12;
  else if (suffix === 'am' && h === 12) h = 0;
  else if (!suffix && h >= 1 && h <= 11 && meal !== 'breakfast' && meal !== 'brunch') h += 12;
  return h * 60 + minute;
}

export function detectPlan(text: string): Detection {
  const meal = MEALS.find(([re]) => re.test(text))?.[1] ?? null;
  const dayOffset = /\btomorrow\b/i.test(text) ? 1 : 0;
  const base = { meal, dayOffset, startMinutes: parseStartMinutes(text, meal) } as const;
  if (!KEYWORDS.test(text)) return { level: 'none', ...base };
  const strong = meal !== null && PROPOSAL.test(text) && !HEDGE.test(text);
  return { level: strong ? 'strong' : 'weak', ...base };
}

export type RsvpStance = 'in' | 'out' | 'unclear';

const OUT =
  /\b(can'?t|cannot|cant|won'?t|not (?:tonight|today|coming|going|gonna)|i'?m out|im out|count me out|pass|nope|no|skip|busy|rain ?check|next time)\b|👎/i;
const IN =
  /^(?:i'?m |im |i am )?(?:in|down|game|there)\b|\b(count me in|i'?ll be there|i'?ll come|i'?m coming|yes|yep|yeah|yea|ya|sure|bet|let'?s go|for sure|absolutely|definitely|sounds good|i'?m down|im down)\b|👍|🙌/i;

/** Rules first: negations win, then clear yeses, else unclear (Haiku decides). */
/** "what are we eating?", "where is it" are questions, never an RSVP. */
export function isQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t.endsWith('?') || /^(what|where|when|who|whose|how|which|why)\s/.test(t);
}

export function parseRsvp(text: string): RsvpStance {
  const t = text.trim();
  if (!t || isQuestion(t)) return 'unclear';
  if (OUT.test(t)) return 'out';
  if (IN.test(t)) return 'in';
  return 'unclear';
}

/** Tapbacks on the headcount message. */
export function stanceFromEmoji(emoji: string): RsvpStance {
  if (['👍', '❤️', '‼️'].includes(emoji)) return 'in';
  if (emoji === '👎') return 'out';
  return 'unclear';
}

export type PlanCommandName = 'wait' | 'resume' | 'cancel' | 'veto' | 'why';

/**
 * Plan commands sent to a bubble while a plan is running. Same words as the engine's
 * parseCommand plus the natural phrasings people use ("why this place?", "hold up").
 */
export function parsePlanCommand(text: string): PlanCommandName | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[.!]+$/, '');
  if (/^(wait|hold on|hold up|pause|hold|stop|wait a sec|one sec)$/.test(t)) return 'wait';
  if (/^(resume|go ahead|continue|unpause|go|carry on|keep going)$/.test(t)) return 'resume';
  if (/^(cancel|cancel (the )?plan|nevermind|never mind|forget the plan|call it off)$/.test(t)) {
    return 'cancel';
  }
  if (
    /^(veto|not there|no not there|somewhere else|different place|pick somewhere else)$/.test(t)
  ) {
    return 'veto';
  }
  if (
    /^(why|why there|why that|why here|explain|how come|why this place|why that place|why this one|why did you pick (this|that)( place)?)\??$/.test(
      t,
    )
  ) {
    return 'why';
  }
  // Status questions: the engine's "why" reply explains where the plan stands right now.
  if (
    /^(what are we (eating|doing|getting)|where are we (going|eating)|what'?s the plan|what'?s happening|what time|when are we (going|eating|meeting)|any update|status|so what'?s the move|what did we pick|where did we land)\??$/.test(
      t,
    )
  ) {
    return 'why';
  }
  return null;
}
