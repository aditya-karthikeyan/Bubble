import { describe, expect, it } from 'vitest';
import { Fact, Venue } from '@bubbleworks/shared';
import { filterCandidates } from './filter.js';
import type { SolverContext, SolverMember } from './types.js';

const ctx: SolverContext = {
  day: 5,
  startMinutes: 19 * 60,
  groupCenter: { lat: 35.9097, lng: -79.0475 },
  meal: 'dinner',
  style: 'sit_down',
};
const budget = Fact.parse({
  id: 'f1',
  userId: 'u1',
  type: 'budget_max',
  value: '15',
  hard: true,
  confidence: 1,
  source: 'manual',
  confirmed: true,
  expiresAt: null,
  createdAt: '2026-10-11T00:00:00.000Z',
});
const member: SolverMember = {
  userId: 'u1',
  displayName: 'U',
  hardFacts: [budget],
  softFacts: [],
  pollChoices: [],
  location: null,
  recentVenueIds: [],
  recentCompromiseCount: 0,
  represented: false,
};
const venue = (id: string, style: 'sit_down' | 'fast_food', typicalCostUsd: number) =>
  Venue.parse({
    id,
    name: id,
    cuisine: 'american',
    style,
    dietTags: [],
    accessibilityTags: [],
    priceLevel: 2,
    typicalCostUsd,
    hours: Array.from({ length: 7 }, () => [{ open: 660, close: 1320 }]),
    phone: '+19195550100',
    location: { lat: 35.911, lng: -79.05 },
    rating: null,
    ratingCount: null,
  });

describe('decided style', () => {
  it('keeps the style when a sit-down place fits', () => {
    const { feasible } = filterCandidates(
      [venue('diner', 'sit_down', 12), venue('burgers', 'fast_food', 10)],
      [member],
      ctx,
    );
    expect(feasible.map((v) => v.id)).toEqual(['diner']);
  });

  it('gives way with no cuisine set when only a fast-food place fits', () => {
    const { feasible } = filterCandidates(
      [venue('steakhouse', 'sit_down', 40), venue('burgers', 'fast_food', 10)],
      [member],
      ctx,
    );
    expect(feasible.map((v) => v.id)).toEqual(['burgers']);
  });

  it('never lets the cuisine give way', () => {
    const { feasible } = filterCandidates(
      [venue('steakhouse', 'sit_down', 40), venue('burgers', 'fast_food', 10)],
      [member],
      { ...ctx, cuisine: 'thai' },
    );
    expect(feasible).toEqual([]);
  });
});
