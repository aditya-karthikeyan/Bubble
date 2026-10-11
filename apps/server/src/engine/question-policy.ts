/**
 * Question policy: ask the group only what changes the decision.
 *
 * Cuisine: ask only when the top three candidates span two or more cuisines AND the bubbles'
 * cuisine preferences disagree or are unknown. Otherwise the solver already knows.
 * Time: infer from free/busy over the candidate windows; ask only when two windows tie (and
 * since the bundle has no time poll yet, a tie falls back to the default and is logged).
 */
import {
  MEAL_TIMES,
  SOLVER,
  type BusyInterval,
  type MealKind,
  type PollOption,
  type Venue,
  type VenueStyle,
} from '@bubbleworks/shared';
import type { SolverContext, SolverMember } from '../solver/types.js';
import { scoreAll } from '../solver/score.js';

export interface CuisineDecision {
  ask: boolean;
  options: PollOption[];
  reason: string;
  /** Cuisines of the top candidates, most support first. */
  topCuisines: string[];
}

const CUISINE_LABELS: Record<string, string> = {
  american: 'Burgers & American',
  pizza: 'Pizza',
  indian: 'Indian',
  thai: 'Thai',
  mexican: 'Mexican',
  mediterranean: 'Mediterranean',
  sushi: 'Sushi',
  ramen: 'Ramen',
  korean: 'Korean',
  chinese: 'Chinese',
  italian: 'Italian',
  healthy: 'Salads & bowls',
  sandwich: 'Sandwiches',
  coffee: 'Coffee & cafe',
  asian: 'Asian',
  other: 'Something else',
};

export function cuisineLabel(key: string): string {
  return CUISINE_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

export function decideCuisineQuestion(
  feasible: Venue[],
  members: SolverMember[],
  ctx: SolverContext,
  namedCuisine: string | null,
): CuisineDecision {
  if (namedCuisine) {
    return {
      ask: false,
      options: [],
      reason: `cuisine named in the message: ${namedCuisine}`,
      topCuisines: [namedCuisine],
    };
  }
  if (feasible.length === 0)
    return { ask: false, options: [], reason: 'no feasible venues', topCuisines: [] };

  const scores = scoreAll(feasible, members, ctx);
  const support = new Map<string, number>();
  for (const s of scores) support.set(s.venueId, (support.get(s.venueId) ?? 0) + s.score);
  const ranked = [...feasible].sort(
    (a, b) => (support.get(b.id) ?? 0) - (support.get(a.id) ?? 0) || a.id.localeCompare(b.id),
  );
  const topCuisines = [...new Set(ranked.slice(0, 3).map((v) => v.cuisine))];
  if (topCuisines.length < 2) {
    return {
      ask: false,
      options: [],
      reason: `top candidates agree on ${topCuisines[0]}`,
      topCuisines,
    };
  }

  const likes = members.map(
    (m) => new Set(m.softFacts.filter((f) => f.type === 'cuisine_like').map((f) => f.value)),
  );
  const known = likes.filter((s) => s.size > 0);
  const unknown = known.length < members.length;
  const agree = known.length > 0 && topCuisines.some((c) => known.every((s) => s.has(c)));
  if (!unknown && agree) {
    return { ask: false, options: [], reason: 'every bubble likes a top cuisine', topCuisines };
  }

  const feasibleCuisines = [...new Set(ranked.map((v) => v.cuisine))].slice(0, 4);
  const options = feasibleCuisines.map((key) => ({ key, label: cuisineLabel(key) }));
  return {
    ask: true,
    options,
    reason: unknown ? 'preferences unknown for some bubbles' : 'bubble preferences disagree',
    topCuisines,
  };
}

/**
 * Cuisine poll options for the people who are in, after the style is known: every cuisine with
 * at least one venue that fits all of them, best supported first, at most four.
 */
export function cuisineOptions(
  feasible: Venue[],
  members: SolverMember[],
  ctx: SolverContext,
): PollOption[] {
  const scores = scoreAll(feasible, members, ctx);
  const support = new Map<string, number>();
  for (const s of scores) support.set(s.venueId, (support.get(s.venueId) ?? 0) + s.score);
  const ranked = [...feasible].sort(
    (a, b) => (support.get(b.id) ?? 0) - (support.get(a.id) ?? 0) || a.id.localeCompare(b.id),
  );
  return [...new Set(ranked.map((v) => v.cuisine))]
    .slice(0, 4)
    .map((key) => ({ key, label: cuisineLabel(key) }));
}

export const STYLE_OPTIONS: PollOption[] = [
  { key: 'sit_down', label: 'Sit-down' },
  { key: 'fast_food', label: 'Fast food / takeout' },
];

export interface StyleDecision {
  ask: boolean;
  options: PollOption[];
  reason: string;
}

/** Ask "sit-down or fast food?" only when the feasible venues include both and nobody said. */
export function decideStyleQuestion(feasible: Venue[], named: VenueStyle | null): StyleDecision {
  if (named) return { ask: false, options: [], reason: `style named in the message: ${named}` };
  const styles = new Set(feasible.map((v) => v.style ?? 'sit_down'));
  if (styles.size < 2)
    return {
      ask: false,
      options: [],
      reason: `every feasible venue is ${[...styles][0] ?? 'unknown'}`,
    };
  return {
    ask: true,
    options: STYLE_OPTIONS,
    reason: 'feasible venues span sit-down and fast food',
  };
}

export interface TimeDecision {
  startMinutes: number;
  /** True when two windows tied on availability and the default broke the tie. */
  tie: boolean;
  /** True when the requested or default time had already passed and was moved later. */
  bumped: boolean;
  freeCounts: Record<number, number>;
}

/** Minimum lead time before a start, so nobody is booked for a time that has passed. */
export const MIN_LEAD_MIN = 45;

/** The usual start for a meal when nobody named a time: 12:30 for lunch, 19:00 for dinner. */
export function defaultStartFor(meal: MealKind = 'dinner'): number {
  return MEAL_TIMES[meal].default_start_min;
}

/** Local minutes since midnight for `now` on `date` in `timezone`, or null when `date` is not today. */
export function minutesNowIfToday(date: string, timezone: string, now: Date): number | null {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const today = `${get('year')}-${get('month')}-${get('day')}`;
  if (today !== date) return null;
  return Number(get('hour')) * 60 + Number(get('minute'));
}

/** Earliest acceptable start today: now + lead, rounded up to :00 or :30. */
export function earliestStart(
  date: string,
  timezone: string,
  now: Date,
  leadMin = MIN_LEAD_MIN,
): number {
  const nowMin = minutesNowIfToday(date, timezone, now);
  if (nowMin === null) return 0;
  return Math.ceil((nowMin + leadMin) / 30) * 30;
}

/**
 * Pick the window where the most members are free; the requested time wins when given. Nothing
 * earlier than `earliestStart` is ever chosen: a passed request or default is bumped forward.
 * Windows and the default come from the meal: lunch looks at midday, dinner at the evening.
 */
export function decideStartTime(
  requested: number | null,
  busyByMember: Record<string, BusyInterval[]>,
  date: string,
  timezone: string,
  now: Date = new Date(),
  meal: MealKind = 'dinner',
): TimeDecision {
  const times = MEAL_TIMES[meal];
  const fallback = times.default_start_min;
  const floor = earliestStart(date, timezone, now);
  if (requested !== null) {
    const startMinutes = Math.max(requested, floor);
    return { startMinutes, tie: false, bumped: startMinutes !== requested, freeCounts: {} };
  }
  const windows = [...times.windows, ...times.late].filter((w) => w >= floor);
  if (windows.length === 0) {
    return { startMinutes: floor, tie: false, bumped: true, freeCounts: {} };
  }
  const freeCounts: Record<number, number> = {};
  for (const w of windows) {
    const start = zonedInstant(date, w, timezone);
    const end = start + SOLVER.meal_duration_min * 60_000;
    let free = 0;
    for (const busy of Object.values(busyByMember)) {
      // All-day blocks (a hackathon on the calendar) say nothing about a meal; skip them.
      const clash = busy.some(
        (b) =>
          Date.parse(b.end) - Date.parse(b.start) < 20 * 60 * 60_000 &&
          Date.parse(b.start) < end &&
          Date.parse(b.end) > start,
      );
      if (!clash) free += 1;
    }
    freeCounts[w] = free;
  }
  const best = Math.max(...Object.values(freeCounts));
  const winners = windows.filter((w) => freeCounts[w] === best);
  const pick = winners.includes(fallback) ? fallback : winners[0]!;
  return {
    startMinutes: pick,
    tie: winners.length > 1,
    bumped: floor > fallback,
    freeCounts,
  };
}

/** Epoch ms for a local date and minutes-since-midnight in a timezone. */
export function zonedInstant(date: string, minutes: number, timezone: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, Math.floor(minutes / 60), minutes % 60);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return guess - (asUtc - guess);
}
