import { describe, expect, it } from 'vitest';
import type { Fact, Venue } from '@bubbleworks/shared';
import { PERSONAS, factsFor } from '@bubbleworks/shared/fakes';
import { HACKATHON_CENTER } from '../venues/demo-venue.js';
import { loadVenuesFile } from '../venues/repo.js';
import { VENUES_FIXTURE } from '../test-helpers.js';
import { solve } from '../solver/rounds.js';
import type { SolverMember } from '../solver/types.js';
import { analyzeDeadlock, pickAsks } from './deadlock.js';
import { askTextIsSafe, templateAsk } from './wording.js';

const venues: Venue[] = loadVenuesFile(VENUES_FIXTURE);
const ctx = {
  day: 6,
  startMinutes: 19 * 60,
  groupCenter: HACKATHON_CENTER,
  meal: 'dinner' as const,
};
const member = (
  id: string,
  fx?: (f: Fact) => Fact,
  over: Partial<SolverMember> = {},
): SolverMember => {
  const facts = factsFor(id).map((f) => (fx ? fx(f) : f));
  return {
    userId: id,
    displayName: PERSONAS.find((p) => p.id === id)!.displayName,
    hardFacts: facts.filter((f) => f.hard),
    softFacts: facts.filter((f) => !f.hard),
    pollChoices: [],
    location: null,
    recentVenueIds: [],
    recentCompromiseCount: 0,
    represented: false,
    ...over,
  };
};
const budget = (usd: string) => (f: Fact) => (f.type === 'budget_max' ? { ...f, value: usd } : f);

describe('analyzeDeadlock', () => {
  it('finds the smallest budget concession that unlocks a venue', () => {
    // Chloe at $10: the cheapest vegetarian-friendly dinner spots run $12, so +5 is enough.
    const members = [member('user_ava'), member('user_chloe', budget('10'))];
    expect(solve({ venues, members, ctx }).winner).toBeNull();
    const a = analyzeDeadlock(venues, members, ctx);
    const chloe = a.concessions.find((c) => c.userId === 'user_chloe' && c.kind === 'budget');
    expect(chloe).toMatchObject({ from: 10, to: 15, steps: 1, cost: 1 });
    expect(chloe!.enablesVenueIds.length).toBeGreaterThan(0);
    for (const id of chloe!.enablesVenueIds)
      expect(venues.find((v) => v.id === id)!.typicalCostUsd).toBeLessThanOrEqual(15);
  });

  it('costs concessions by size times (1 + recent compromises) and never relaxes protected facts', () => {
    const members = [
      member('user_ava'),
      member('user_chloe', budget('15'), { recentCompromiseCount: 2 }),
    ];
    const a = analyzeDeadlock(venues, members, ctx);
    const chloe = a.concessions.find((c) => c.userId === 'user_chloe' && c.kind === 'budget')!;
    expect(chloe.cost).toBe(3);
    for (const c of a.concessions) expect(['budget', 'distance']).toContain(c.kind);
    // Chloe is halal: no concession touches religious_diet, and Ava's vegetarian diet is untouched.
    expect(
      a.concessions.every((c) => c.factType === 'budget_max' || c.factType === 'distance'),
    ).toBe(true);
  });

  it('gives up when the gap is beyond the maximum step', () => {
    const pricey = venues.filter((v) => v.typicalCostUsd >= 18);
    const members = [member('user_ava'), member('user_chloe', budget('2'))];
    const a = analyzeDeadlock(pricey, members, ctx);
    expect(a.concessions.filter((c) => c.userId === 'user_chloe')).toEqual([]);
  });

  it('picks the two cheapest asks for two different people', () => {
    const members = [
      member('user_ava', budget('15'), { recentCompromiseCount: 3 }),
      member('user_chloe', budget('15')),
    ];
    const a = analyzeDeadlock(venues, members, ctx);
    const asks = pickAsks(a);
    expect(asks.map((c) => c.userId)).toEqual(['user_chloe', 'user_ava']);
    expect(asks[0]!.cost).toBeLessThanOrEqual(asks[1]!.cost);
  });

  it('finds a time shift when the only problem is hours', () => {
    // 21:30 start: most places close too soon; shifting earlier opens them up.
    const members = [member('user_dev')];
    const late = { ...ctx, startMinutes: 21 * 60 + 30 };
    const { winner } = solve({ venues, members, ctx: late });
    const a = analyzeDeadlock(venues, members, late);
    if (winner === null) expect(a.timeShift).not.toBeNull();
    else expect(a.timeShift === null || a.timeShift.enablesVenueIds.length > 0).toBe(true);
  });

  it('an accepted concession makes the solver lock', () => {
    const members = [
      member('user_ava'),
      member('user_chloe', budget('15'), { slack: { budgetUsd: 5 } }),
    ];
    expect(solve({ venues, members, ctx }).winner?.id).toBe('venue_demo');
  });
});

describe('ask wording', () => {
  const input = {
    kind: 'budget' as const,
    from: 15,
    to: 20,
    venueName: 'The Demo Table',
    meal: 'dinner',
    firstName: 'Chloe',
    forbiddenNames: ['Ava', 'Ben', 'Dev', 'Eli'],
  };
  it('template names only the recipient and asks for yes or no', () => {
    const text = templateAsk(input);
    expect(text).toContain('Chloe');
    expect(text).toMatch(/yes or no/);
    expect(askTextIsSafe(text, input)).toBe(true);
  });
  it('rejects drafts that mention anyone else', () => {
    expect(
      askTextIsSafe(
        'Hey Chloe, Ava really wants to go, can you stretch to $20? Reply yes or no.',
        input,
      ),
    ).toBe(false);
    expect(askTextIsSafe('short', input)).toBe(false);
  });
});
