/**
 * Hard filter. A venue survives only when every member marked in can use it: open for the meal,
 * compatible with diet, allergy, religious and accessibility facts, within budget, and within
 * walking range of the member's live location or the group's center.
 */
import { SOLVER, type Venue } from '@bubbleworks/shared';
import { incompatibilities } from '../venues/compat.js';
import { distanceM, walkMinutes } from '../venues/geo.js';
import { isOpenAt } from '../venues/hours.js';
import type { Infeasibility, SolverContext, SolverMember } from './types.js';

export function budgetOf(member: Pick<SolverMember, 'hardFacts'>): number | null {
  const fact = member.hardFacts.find((f) => f.type === 'budget_max');
  const n = fact ? Number(fact.value) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function travelMinutes(
  member: SolverMember,
  venue: Venue,
  ctx: SolverContext,
): number | null {
  const from = member.location ?? ctx.groupCenter;
  return from ? walkMinutes(distanceM(from, venue.location)) : null;
}

/** Why this venue fails for this member, or [] when it works. */
export function memberInfeasibilities(
  venue: Venue,
  member: SolverMember,
  ctx: SolverContext,
  options: { budgetSlackUsd?: number; travelSlackMin?: number } = {},
): Infeasibility[] {
  const out: Infeasibility[] = [];
  for (const bad of incompatibilities(venue, member.hardFacts)) {
    out.push({
      venueId: venue.id,
      userId: member.userId,
      reason: 'diet',
      detail: `${bad.factType}:${bad.value}:${bad.reason}`,
    });
  }
  const budget = budgetOf(member);
  const budgetSlack = options.budgetSlackUsd ?? member.slack?.budgetUsd ?? 0;
  const travelSlack = options.travelSlackMin ?? member.slack?.travelMin ?? 0;
  if (budget !== null && venue.typicalCostUsd > budget + budgetSlack) {
    out.push({
      venueId: venue.id,
      userId: member.userId,
      reason: 'budget',
      detail: `budget ${budget} < ${venue.typicalCostUsd}`,
    });
  }
  const minutes = travelMinutes(member, venue, ctx);
  const limit = ctx.travelLimitMin ?? SOLVER.travel_limit_min;
  if (minutes !== null && minutes > limit + travelSlack) {
    out.push({
      venueId: venue.id,
      userId: member.userId,
      reason: 'distance',
      detail: `walk ${minutes} min`,
    });
  }
  return out;
}

const COFFEE_ONLY = new Set(['coffee']);

/** Coffee shops serve the coffee meal; everything else serves the other meals. */
export function fitsMeal(venue: Venue, meal: SolverContext['meal']): boolean {
  if (!meal) return true;
  return meal === 'coffee' ? COFFEE_ONLY.has(venue.cuisine) : !COFFEE_ONLY.has(venue.cuisine);
}

/**
 * Filters candidates. When nothing fits both the decided style and the decided cuisine, the
 * style gives way (the cuisine vote is the more specific one). The cuisine never silently gives
 * way: the engine asks the people who voted for it first.
 */
export function filterCandidates(
  venues: Venue[],
  members: SolverMember[],
  ctx: SolverContext,
): { feasible: Venue[]; infeasible: Infeasibility[] } {
  const strict = filterStrict(venues, members, ctx);
  if (strict.feasible.length || !ctx.cuisine || !ctx.style) return strict;
  return filterStrict(venues, members, { ...ctx, style: null });
}

function filterStrict(
  venues: Venue[],
  members: SolverMember[],
  ctx: SolverContext,
): { feasible: Venue[]; infeasible: Infeasibility[] } {
  const feasible: Venue[] = [];
  const infeasible: Infeasibility[] = [];
  for (const venue of venues) {
    const problems: Infeasibility[] = [];
    const style = venue.style ?? 'sit_down';
    if (ctx.style && style !== ctx.style) {
      problems.push({
        venueId: venue.id,
        userId: null,
        reason: 'style',
        detail: `${style} but the table wants ${ctx.style}`,
      });
    }
    if (ctx.cuisine && venue.cuisine !== ctx.cuisine) {
      problems.push({
        venueId: venue.id,
        userId: null,
        reason: 'cuisine',
        detail: `${venue.cuisine} but the table voted ${ctx.cuisine}`,
      });
    }
    if (
      venue.rating !== null &&
      venue.rating !== undefined &&
      (venue.ratingCount ?? 0) >= SOLVER.min_rating_reviews &&
      venue.rating < SOLVER.min_rating
    ) {
      problems.push({
        venueId: venue.id,
        userId: null,
        reason: 'rating',
        detail: `${venue.rating} stars over ${venue.ratingCount} reviews`,
      });
    }
    if (!fitsMeal(venue, ctx.meal)) {
      problems.push({
        venueId: venue.id,
        userId: null,
        reason: 'meal',
        detail: `${venue.cuisine} does not serve ${ctx.meal}`,
      });
    }
    if (!isOpenAt(venue.hours, ctx.day, ctx.startMinutes, SOLVER.meal_duration_min)) {
      problems.push({
        venueId: venue.id,
        userId: null,
        reason: 'closed',
        detail: `closed at ${ctx.startMinutes}`,
      });
    }
    for (const m of members) problems.push(...memberInfeasibilities(venue, m, ctx));
    if (problems.length) infeasible.push(...problems);
    else feasible.push(venue);
  }
  feasible.sort((a, b) => a.id.localeCompare(b.id));
  return { feasible, infeasible };
}
