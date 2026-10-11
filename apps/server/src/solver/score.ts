/**
 * Soft scoring. Each component is 0..1, weighted by SOLVER.weights, then normalized per member
 * across the current candidate set so every bubble's scores span 0..1 and the page can animate
 * drift. Deterministic: same inputs, same numbers.
 */
import { SOLVER, type Venue } from '@bubbleworks/shared';
import { budgetOf, travelMinutes } from './filter.js';
import type { MemberScore, SolverContext, SolverMember } from './types.js';

const W = SOLVER.weights;

export function rawScore(venue: Venue, member: SolverMember, ctx: SolverContext): number {
  let score = 0;
  let maxPossible = 0;

  const likes = member.softFacts.filter((f) => f.type === 'cuisine_like').map((f) => f.value);
  const avoids = member.softFacts.filter((f) => f.type === 'cuisine_avoid').map((f) => f.value);
  maxPossible += W.cuisine_like;
  if (likes.includes(venue.cuisine)) score += W.cuisine_like;
  // Avoid is a penalty: start with full credit and lose it.
  maxPossible += W.cuisine_avoid;
  score += avoids.includes(venue.cuisine) ? 0 : W.cuisine_avoid;

  if (member.pollChoices.length) {
    maxPossible += W.poll_vote;
    if (member.pollChoices.includes(venue.cuisine)) score += W.poll_vote;
  }

  const favorites = member.softFacts.filter((f) => f.type === 'favorite_venue').map((f) => f.value);
  if (favorites.length) {
    maxPossible += W.favorite;
    if (favorites.includes(venue.id)) score += W.favorite;
  }

  const minutes = travelMinutes(member, venue, ctx);
  if (minutes !== null) {
    maxPossible += W.distance;
    const limit = ctx.travelLimitMin ?? SOLVER.travel_limit_min;
    score += W.distance * Math.max(0, 1 - minutes / limit);
  }

  // Reviews: 3.5 stars is neutral, 5 is full credit; a handful of reviews counts for less than 50.
  if (venue.rating !== null && venue.rating !== undefined) {
    maxPossible += W.rating;
    const quality = Math.max(0, Math.min(1, (venue.rating - 3.5) / 1.5));
    const confidence = Math.min(1, (venue.ratingCount ?? 0) / 50);
    score += W.rating * (0.5 + (quality - 0.5) * confidence);
  }

  maxPossible += W.recent_visit;
  const recentIdx = member.recentVenueIds.indexOf(venue.id);
  score += W.recent_visit * (recentIdx === -1 ? 1 : Math.min(1, recentIdx / 5));

  const budget = budgetOf(member);
  if (budget !== null) {
    maxPossible += W.budget_headroom;
    score +=
      W.budget_headroom * Math.max(0, Math.min(1, (budget - venue.typicalCostUsd) / budget + 0.5));
  }

  return maxPossible > 0 ? score / maxPossible : 0.5;
}

/** Fairness weight: members who compromised recently get a louder vote. */
export function fairnessWeight(member: SolverMember): number {
  return Math.min(SOLVER.fairness_max, 1 + SOLVER.fairness_step * member.recentCompromiseCount);
}

/** Per-member normalized scores over the candidate set. */
export function scoreAll(
  candidates: Venue[],
  members: SolverMember[],
  ctx: SolverContext,
): MemberScore[] {
  const out: MemberScore[] = [];
  for (const m of members) {
    const raw = candidates.map((v) => ({ v, s: rawScore(v, m, ctx) }));
    const lo = Math.min(...raw.map((r) => r.s));
    const hi = Math.max(...raw.map((r) => r.s));
    for (const { v, s } of raw) {
      const norm = hi > lo ? (s - lo) / (hi - lo) : 1;
      const score = Math.round(norm * 1000) / 1000;
      out.push({
        userId: m.userId,
        venueId: v.id,
        score,
        approves: score >= SOLVER.approve_threshold,
      });
    }
  }
  return out;
}
