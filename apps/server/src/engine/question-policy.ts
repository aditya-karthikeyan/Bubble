/**
 * Question policy: ask the group only what changes the decision.
 *
 * Cuisine: ask only when the top three candidates span two or more cuisines AND the bubbles'
 * cuisine preferences disagree or are unknown. Otherwise the solver already knows.
 * Time: infer from free/busy over the candidate windows; ask only when two windows tie (and
 * since the bundle has no time poll yet, a tie falls back to the default and is logged).
 */
import { SOLVER, type BusyInterval, type PollOption, type Venue } from '@bubbleworks/shared';
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

export interface TimeDecision {
  startMinutes: number;
  /** True when two windows tied on availability and the default broke the tie. */
  tie: boolean;
  freeCounts: Record<number, number>;
}

/** Pick the window where the most members are free; the requested time wins when given. */
export function decideStartTime(
  requested: number | null,
  busyByMember: Record<string, BusyInterval[]>,
  date: string,
  timezone: string,
): TimeDecision {
  if (requested !== null) return { startMinutes: requested, tie: false, freeCounts: {} };
  const windows = SOLVER.time_windows_min;
  const freeCounts: Record<number, number> = {};
  for (const w of windows) {
    const start = zonedInstant(date, w, timezone);
    const end = start + SOLVER.meal_duration_min * 60_000;
    let free = 0;
    for (const busy of Object.values(busyByMember)) {
      const clash = busy.some((b) => Date.parse(b.start) < end && Date.parse(b.end) > start);
      if (!clash) free += 1;
    }
    freeCounts[w] = free;
  }
  const best = Math.max(...Object.values(freeCounts));
  const winners = windows.filter((w) => freeCounts[w] === best);
  const pick = winners.includes(SOLVER.default_start_min) ? SOLVER.default_start_min : winners[0]!;
  return { startMinutes: pick, tie: winners.length > 1, freeCounts };
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
