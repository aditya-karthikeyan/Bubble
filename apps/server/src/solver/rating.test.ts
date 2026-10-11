import { describe, expect, it } from 'vitest';
import { Venue } from '@bubbleworks/shared';
import { filterCandidates } from './filter.js';
import { rawScore } from './score.js';
import type { SolverContext, SolverMember } from './types.js';

const ctx: SolverContext = {
  day: 5,
  startMinutes: 19 * 60,
  groupCenter: { lat: 35.9097, lng: -79.0475 },
  meal: 'dinner',
};
const member: SolverMember = {
  userId: 'u1',
  displayName: 'U',
  hardFacts: [],
  softFacts: [],
  pollChoices: [],
  location: null,
  recentVenueIds: [],
  recentCompromiseCount: 0,
  represented: false,
};
const venue = (id: string, rating: number | null, ratingCount: number | null) =>
  Venue.parse({
    id,
    name: id,
    cuisine: 'chinese',
    style: 'sit_down',
    dietTags: [],
    accessibilityTags: [],
    priceLevel: 2,
    typicalCostUsd: 22,
    hours: Array.from({ length: 7 }, () => [{ open: 660, close: 1320 }]),
    phone: '+19195550100',
    location: { lat: 35.911, lng: -79.05 },
    rating,
    ratingCount,
  });

describe('reviews', () => {
  it('drops low-rated places that have enough reviews, keeps the unknown and the barely reviewed', () => {
    const { feasible, infeasible } = filterCandidates(
      [
        venue('bad', 2.9, 240),
        venue('new', 2.0, 3),
        venue('unknown', null, null),
        venue('good', 4.6, 500),
      ],
      [member],
      ctx,
    );
    expect(feasible.map((v) => v.id)).toEqual(['good', 'new', 'unknown']);
    expect(infeasible.map((i) => [i.venueId, i.reason])).toEqual([['bad', 'rating']]);
  });

  it('scores a well-reviewed place above an average one, and ignores thin review counts', () => {
    const great = rawScore(venue('great', 4.7, 900), member, ctx);
    const meh = rawScore(venue('meh', 3.7, 900), member, ctx);
    const thin = rawScore(venue('thin', 5, 2), member, ctx);
    const unknown = rawScore(venue('unknown', null, null), member, ctx);
    expect(great).toBeGreaterThan(meh);
    expect(Math.abs(thin - unknown)).toBeLessThan(0.05);
  });
});
