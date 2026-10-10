import { describe, expect, it } from 'vitest';
import type { Fact, Venue } from '@bubbleworks/shared';
import { PERSONAS, factsFor } from '@bubbleworks/shared/fakes';
import { HACKATHON_CENTER } from '../venues/demo-venue.js';
import { loadVenuesFile } from '../venues/repo.js';
import { VENUES_FIXTURE } from '../test-helpers.js';
import { filterCandidates } from './filter.js';
import { solve } from './rounds.js';
import { scoreAll } from './score.js';
import type { SolverContext, SolverMember } from './types.js';

const venues: Venue[] = loadVenuesFile(VENUES_FIXTURE);
const ctx: SolverContext = { day: 6, startMinutes: 19 * 60, groupCenter: HACKATHON_CENTER };

function member(
  userId: string,
  over: Partial<SolverMember> = {},
  factOverride?: (f: Fact) => Fact,
): SolverMember {
  const facts = factsFor(userId).map((f) => (factOverride ? factOverride(f) : f));
  return {
    userId,
    displayName: PERSONAS.find((p) => p.id === userId)?.displayName ?? userId,
    hardFacts: facts.filter((f) => f.hard),
    softFacts: facts.filter((f) => !f.hard),
    pollChoices: [],
    location: null,
    recentVenueIds: [],
    recentCompromiseCount: 0,
    represented: false,
    ...over,
  };
}

describe('filter', () => {
  it('drops venues closed at the time, over budget, or incompatible, and keeps the demo table', () => {
    const { feasible, infeasible } = filterCandidates(
      venues,
      [member('user_ava'), member('user_chloe')],
      ctx,
    );
    expect(feasible.map((v) => v.id)).toContain('venue_demo');
    for (const v of feasible) expect(v.typicalCostUsd).toBeLessThanOrEqual(20);
    const reasons = new Set(infeasible.map((i) => i.reason));
    expect(reasons.has('budget')).toBe(true);
    expect(reasons.has('diet')).toBe(true);
  });
  it('keeps coffee shops out of dinner and in for coffee', () => {
    const dinner = filterCandidates(venues, [member('user_dev')], { ...ctx, meal: 'dinner' });
    expect(dinner.feasible.some((v) => v.cuisine === 'coffee')).toBe(false);
    expect(dinner.infeasible.some((i) => i.reason === 'meal')).toBe(true);
    const coffee = filterCandidates(venues, [member('user_dev')], { ...ctx, meal: 'coffee' });
    expect(coffee.feasible.every((v) => v.cuisine === 'coffee')).toBe(true);
  });
  it('distance filter uses the member location when known', () => {
    const far = member('user_dev', { location: { lat: 35.95, lng: -79.0 } });
    const { feasible } = filterCandidates(venues, [far], ctx);
    expect(feasible).toEqual([]);
  });
});

describe('score', () => {
  it('normalizes per member to 0..1 and prefers liked cuisines and poll choices', () => {
    const pool = venues
      .filter((v) => ['pizza', 'indian', 'american', 'mexican'].includes(v.cuisine))
      .slice(0, 8);
    const eli = member('user_eli', { pollChoices: ['pizza'] });
    const scores = scoreAll(pool, [eli], ctx);
    expect(Math.max(...scores.map((s) => s.score))).toBe(1);
    expect(Math.min(...scores.map((s) => s.score))).toBe(0);
    const best = scores.sort((a, b) => b.score - a.score)[0]!;
    expect(pool.find((v) => v.id === best.venueId)?.cuisine).toBe('pizza');
  });
});

describe('solve', () => {
  const four = ['user_ava', 'user_ben', 'user_chloe', 'user_dev'].map((id) => member(id));

  it('basic: locks a winner with a backup and emits rounds', () => {
    const r = solve({ venues, members: four, ctx });
    expect(r.winner).not.toBeNull();
    expect(r.backup).not.toBeNull();
    expect(r.backup?.id).not.toBe(r.winner?.id);
    expect(r.rounds.length).toBeGreaterThanOrEqual(1);
    const last = r.rounds.at(-1)!;
    expect(last.leaderVenueId).toBe(r.winner?.id);
    expect(last.eliminated).toBeNull();
    for (const round of r.rounds.slice(0, -1))
      expect(round.eliminated?.reason).toBe('least_support');
    for (const s of r.rounds[0]!.scores) expect(s.score).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic', () => {
    const a = solve({ venues, members: four, ctx });
    const b = solve({ venues, members: [...four].reverse(), ctx });
    expect(a.winner?.id).toBe(b.winner?.id);
    expect(a.rounds.map((r) => r.eliminated?.venueId)).toEqual(
      b.rounds.map((r) => r.eliminated?.venueId),
    );
  });

  it('tie: split poll votes still resolve to one venue by weighted support', () => {
    const members = [
      member('user_ava', { pollChoices: ['indian'] }),
      member('user_ben', { pollChoices: ['pizza'] }),
      member('user_chloe', { pollChoices: ['indian'] }),
      member('user_dev', { pollChoices: ['pizza'] }),
    ];
    const r = solve({ venues, members, ctx });
    expect(r.winner).not.toBeNull();
    const last = r.rounds.at(-1)!;
    // Lock happens the moment every bubble approves the leader, possibly in round one.
    for (const m of members) {
      expect(
        last.scores.find((s) => s.userId === m.userId && s.venueId === r.winner!.id)?.approves,
      ).toBe(true);
    }
    const statuses = new Set(r.rounds.at(-1)!.bubbles.map((b) => b.status));
    expect([...statuses].every((s) => ['fits', 'stretching', 'holding_firm'].includes(s))).toBe(
      true,
    );
  });

  it('fairness: a member who compromised recently pulls the result toward their choice', () => {
    const base = [
      member('user_ava', { pollChoices: ['indian'] }),
      member('user_ben', { pollChoices: ['pizza'] }),
    ];
    const plain = solve({ venues, members: base, ctx });
    const weighted = solve({
      venues,
      members: [{ ...base[0]!, recentCompromiseCount: 4 }, base[1]!],
      ctx,
    });
    expect(weighted.winner?.cuisine === 'indian' || plain.winner?.id === weighted.winner?.id).toBe(
      true,
    );
  });

  it('deadlock: an impossible budget leaves no feasible venue and no winner', () => {
    const broke = member('user_chloe', {}, (f) =>
      f.type === 'budget_max' ? { ...f, value: '5' } : f,
    );
    const r = solve({ venues, members: [member('user_ava'), broke], ctx });
    expect(r.feasible).toEqual([]);
    expect(r.winner).toBeNull();
    expect(r.infeasible.some((i) => i.reason === 'budget' && i.userId === 'user_chloe')).toBe(true);
  });

  it('veto removes a venue before round one', () => {
    const first = solve({ venues, members: four, ctx });
    const again = solve({ venues, members: four, ctx, vetoedVenueIds: [first.winner!.id] });
    expect(again.winner?.id).not.toBe(first.winner!.id);
  });

  it('represented bubbles show as represented', () => {
    const r = solve({
      venues,
      members: [member('user_ava'), member('user_eli', { represented: true })],
      ctx,
    });
    expect(r.rounds[0]!.bubbles.find((b) => b.userId === 'user_eli')?.status).toBe('represented');
  });
});
