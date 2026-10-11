import { describe, expect, it } from 'vitest';
import type { Venue } from '@bubbleworks/shared';
import { PERSONAS, factsFor } from '@bubbleworks/shared/fakes';
import { HACKATHON_CENTER } from '../venues/demo-venue.js';
import { loadVenuesFile } from '../venues/repo.js';
import { VENUES_FIXTURE } from '../test-helpers.js';
import { filterCandidates } from '../solver/filter.js';
import type { SolverMember } from '../solver/types.js';
import {
  decideCuisineQuestion,
  decideStartTime,
  earliestStart,
  zonedInstant,
  decideStyleQuestion,
} from './question-policy.js';

const venues: Venue[] = loadVenuesFile(VENUES_FIXTURE);
const ctx = { day: 6, startMinutes: 19 * 60, groupCenter: HACKATHON_CENTER };
const member = (id: string, softOverride?: SolverMember['softFacts']): SolverMember => ({
  userId: id,
  displayName: PERSONAS.find((p) => p.id === id)!.displayName,
  hardFacts: factsFor(id).filter((f) => f.hard),
  softFacts: softOverride ?? factsFor(id).filter((f) => !f.hard),
  pollChoices: [],
  location: null,
  recentVenueIds: [],
  recentCompromiseCount: 0,
  represented: false,
});

describe('cuisine question', () => {
  it('skips when the message named a cuisine', () => {
    expect(decideCuisineQuestion(venues, [member('user_ava')], ctx, 'pizza').ask).toBe(false);
  });
  it('asks when top candidates span cuisines and preferences disagree', () => {
    const members = [member('user_ava'), member('user_ben'), member('user_eli')];
    const { feasible } = filterCandidates(venues, members, { ...ctx, meal: 'dinner' });
    const d = decideCuisineQuestion(feasible, members, ctx, null);
    expect(d.ask).toBe(true);
    expect(d.options.length).toBeGreaterThanOrEqual(2);
    expect(d.options.length).toBeLessThanOrEqual(4);
    expect(d.options.every((o) => o.key && o.label)).toBe(true);
  });
  it('skips when every bubble already likes a top cuisine', () => {
    const likePizza = (id: string) =>
      member(id, [
        {
          ...factsFor('user_eli').find((f) => f.type === 'cuisine_like')!,
          userId: id,
          value: 'pizza',
        },
      ]);
    const d = decideCuisineQuestion(
      venues.filter((v) => v.cuisine === 'pizza' || v.cuisine === 'mexican'),
      [likePizza('user_ava'), likePizza('user_dev')],
      ctx,
      null,
    );
    expect(d.ask).toBe(false);
  });
});

describe('start time', () => {
  const afternoon = new Date('2026-10-10T21:00:00.000Z'); // 17:00 New York
  it('honours a requested time', () => {
    expect(
      decideStartTime(20 * 60, {}, '2026-10-10', 'America/New_York', afternoon).startMinutes,
    ).toBe(20 * 60);
  });
  it('avoids the window where someone is busy', () => {
    const busyAt7 = {
      start: new Date(zonedInstant('2026-10-10', 19 * 60, 'America/New_York')).toISOString(),
      end: new Date(zonedInstant('2026-10-10', 20 * 60, 'America/New_York')).toISOString(),
    };
    const d = decideStartTime(
      null,
      { a: [busyAt7], b: [] },
      '2026-10-10',
      'America/New_York',
      afternoon,
    );
    expect(d.startMinutes).not.toBe(19 * 60);
    expect(d.freeCounts[19 * 60]).toBe(1);
  });
  it('breaks a tie with the default', () => {
    const d = decideStartTime(null, { a: [], b: [] }, '2026-10-10', 'America/New_York', afternoon);
    expect(d).toMatchObject({ startMinutes: 19 * 60, tie: true });
  });
  it('picks 12:30 for lunch when nobody is busy', () => {
    const d = decideStartTime(
      null,
      { a: [], b: [] },
      '2026-10-11',
      'America/New_York',
      afternoon,
      'lunch',
    );
    expect(d).toMatchObject({ startMinutes: 12 * 60 + 30, bumped: false });
    expect(Object.keys(d.freeCounts).map(Number)).toEqual([690, 720, 750, 780, 810, 840, 870]);
  });
  it('picks 9:00 for breakfast when nobody is busy', () => {
    const d = decideStartTime(
      null,
      { a: [] },
      '2026-10-11',
      'America/New_York',
      afternoon,
      'breakfast',
    );
    expect(d).toMatchObject({ startMinutes: 9 * 60, bumped: false });
  });
  it('keeps dinner at 7 PM whether the meal is passed or not', () => {
    const tz = 'America/New_York';
    expect(decideStartTime(null, { a: [] }, '2026-10-11', tz, afternoon, 'dinner')).toMatchObject({
      startMinutes: 19 * 60,
    });
    expect(decideStartTime(null, { a: [] }, '2026-10-11', tz, afternoon).startMinutes).toBe(
      19 * 60,
    );
  });
  it('moves lunch off a busy 12:30 to another midday window', () => {
    const busy = {
      start: new Date(zonedInstant('2026-10-11', 12 * 60, 'America/New_York')).toISOString(),
      end: new Date(zonedInstant('2026-10-11', 13 * 60 + 30, 'America/New_York')).toISOString(),
    };
    const d = decideStartTime(
      null,
      { a: [busy] },
      '2026-10-11',
      'America/New_York',
      afternoon,
      'lunch',
    );
    expect(d.startMinutes).toBeGreaterThanOrEqual(11 * 60 + 30);
    expect(d.startMinutes).toBeLessThanOrEqual(14 * 60 + 30);
    expect(d.startMinutes).not.toBe(12 * 60 + 30);
  });
  it('zonedInstant converts local minutes to the right instant', () => {
    // 19:00 EDT on 2026-10-10 is 23:00Z.
    expect(new Date(zonedInstant('2026-10-10', 19 * 60, 'America/New_York')).toISOString()).toBe(
      '2026-10-10T23:00:00.000Z',
    );
  });
});

describe('start time never in the past', () => {
  const tz = 'America/New_York';
  const late = new Date('2026-10-11T00:53:00.000Z'); // 8:53 PM New York on 2026-10-10
  it('floors to now + 45 min rounded up to the half hour', () => {
    expect(earliestStart('2026-10-10', tz, late)).toBe(22 * 60); // 21:38 -> 22:00
    expect(earliestStart('2026-10-11', tz, late)).toBe(0); // tomorrow: no floor
    expect(earliestStart('2026-10-10', tz, new Date('2026-10-10T21:00:00.000Z'))).toBe(18 * 60); // 17:45 -> 18:00
  });
  it('bumps the default past the floor instead of booking 7 PM at 8:53 PM', () => {
    const d = decideStartTime(null, {}, '2026-10-10', tz, late);
    expect(d.startMinutes).toBeGreaterThanOrEqual(22 * 60);
    expect(d.bumped).toBe(true);
  });
  it('bumps a requested time that has passed and leaves a future one alone', () => {
    expect(decideStartTime(19 * 60, {}, '2026-10-10', tz, late)).toMatchObject({
      startMinutes: 22 * 60,
      bumped: true,
    });
    expect(decideStartTime(19 * 60, {}, '2026-10-11', tz, late)).toMatchObject({
      startMinutes: 19 * 60,
      bumped: false,
    });
    expect(
      decideStartTime(null, {}, '2026-10-10', tz, new Date('2026-10-10T21:00:00.000Z')),
    ).toMatchObject({ startMinutes: 19 * 60, bumped: false });
  });
});

describe('style question', () => {
  it('asks only when feasible venues span both styles and nothing was named', () => {
    const both = venues
      .filter((v) => v.style === 'fast_food')
      .slice(0, 2)
      .concat(venues.filter((v) => (v.style ?? 'sit_down') === 'sit_down').slice(0, 2));
    expect(decideStyleQuestion(both, null)).toMatchObject({ ask: true });
    expect(decideStyleQuestion(both, 'fast_food').ask).toBe(false);
    expect(
      decideStyleQuestion(
        venues.filter((v) => v.style === 'fast_food'),
        null,
      ).ask,
    ).toBe(false);
  });
});
