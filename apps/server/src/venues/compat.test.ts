import { describe, expect, it } from 'vitest';
import type { Fact, Venue } from '@bubbleworks/shared';
import { PERSONA_FACTS, factsFor } from '@bubbleworks/shared/fakes';
import { allWeek } from './hours.js';
import { incompatibilities, isCompatible } from './compat.js';

const venue = (over: Partial<Venue>): Venue => ({
  id: 'v',
  name: 'V',
  cuisine: 'american',
  dietTags: [],
  accessibilityTags: [],
  priceLevel: 2,
  typicalCostUsd: 22,
  hours: allWeek({ open: 0, close: 1440 }),
  phone: '+19195550000',
  location: { lat: 0, lng: 0 },
  address: null,
  neighborhood: null,
  isDemo: false,
  ...over,
});

describe('hard fact compatibility', () => {
  it('vegetarian needs a vegetarian or vegan tag', () => {
    const ava = factsFor('user_ava');
    expect(isCompatible(venue({ dietTags: [] }), ava)).toBe(false);
    expect(isCompatible(venue({ dietTags: ['vegan'] }), ava)).toBe(true);
    expect(isCompatible(venue({ dietTags: ['vegetarian'] }), ava)).toBe(true);
  });

  it('no_pork / no_beef rule out meat-centered cuisines without needing a tag', () => {
    const fact = (value: string): Fact => ({
      id: value,
      userId: 'u',
      type: 'diet',
      value,
      hard: true,
      confidence: 1,
      source: 'onboarding',
      confirmed: true,
      expiresAt: null,
      createdAt: '2026-10-10T00:00:00Z',
    });
    expect(isCompatible(venue({ cuisine: 'thai' }), [fact('no_pork'), fact('no_beef')])).toBe(true);
    expect(isCompatible(venue({ cuisine: 'hot_dog' }), [fact('no_pork')])).toBe(false);
    expect(isCompatible(venue({ cuisine: 'burger' }), [fact('no_beef')])).toBe(false);
    expect(isCompatible(venue({ cuisine: 'burger' }), [fact('no_pork')])).toBe(true);
  });

  it('halal accepts tagged halal or vegetarian-capable venues', () => {
    const chloe = factsFor('user_chloe');
    expect(isCompatible(venue({ dietTags: [] }), chloe)).toBe(false);
    expect(isCompatible(venue({ dietTags: ['halal'] }), chloe)).toBe(true);
    expect(isCompatible(venue({ dietTags: ['vegetarian'] }), chloe)).toBe(true);
  });

  it('peanut allergy excludes risky cuisines unless peanut_free', () => {
    const ben = factsFor('user_ben');
    expect(isCompatible(venue({ cuisine: 'thai' }), ben)).toBe(false);
    expect(isCompatible(venue({ cuisine: 'thai', dietTags: ['peanut_free'] }), ben)).toBe(true);
    expect(isCompatible(venue({ cuisine: 'pizza' }), ben)).toBe(true);
    expect(incompatibilities(venue({ cuisine: 'chinese' }), ben)).toEqual([
      { factType: 'allergy', value: 'peanut', reason: 'allergen_risk' },
    ]);
  });

  it('wheelchair excludes only an explicit no', () => {
    const eli = factsFor('user_eli');
    expect(isCompatible(venue({ accessibilityTags: [] }), eli)).toBe(true);
    expect(isCompatible(venue({ accessibilityTags: ['wheelchair'] }), eli)).toBe(true);
    expect(isCompatible(venue({ accessibilityTags: ['no_wheelchair'] }), eli)).toBe(false);
  });

  it('ignores soft facts and budget', () => {
    const soft: Fact[] = PERSONA_FACTS.filter((f) => !f.hard);
    expect(isCompatible(venue({ cuisine: 'thai' }), soft)).toBe(true);
    expect(
      isCompatible(
        venue({ typicalCostUsd: 500 }),
        factsFor('user_chloe').filter((f) => f.type === 'budget_max'),
      ),
    ).toBe(true);
  });
});

describe('no pork / no beef', () => {
  const noPork: Fact = {
    ...factsFor('user_ava').find((f) => f.type === 'diet')!,
    userId: 'user_x',
    value: 'no_pork',
  };
  const noBeef: Fact = { ...noPork, value: 'no_beef' };
  it('fails hot dog, burger, bbq kitchens even with a veg option', () => {
    const supDogs = venue({
      cuisine: 'american',
      cuisineTags: ['american', 'hot_dog'],
      dietTags: ['vegetarian'],
      style: 'fast_food',
    });
    expect(isCompatible(supDogs, [noPork])).toBe(false);
    expect(isCompatible(supDogs, [noBeef])).toBe(false);
    expect(isCompatible(venue({ cuisine: 'american', cuisineTags: ['burger'] }), [noBeef])).toBe(
      false,
    );
    expect(isCompatible(venue({ cuisine: 'american', cuisineTags: ['burger'] }), [noPork])).toBe(
      true,
    );
    expect(isCompatible(venue({ cuisine: 'american', cuisineTags: ['bbq'] }), [noPork])).toBe(
      false,
    );
  });
  it('passes kitchens that are not meat-centric', () => {
    expect(
      isCompatible(venue({ cuisine: 'american', cuisineTags: ['chicken'] }), [noPork, noBeef]),
    ).toBe(true);
    expect(isCompatible(venue({ cuisine: 'indian', dietTags: ['vegetarian'] }), [noBeef])).toBe(
      true,
    );
    expect(isCompatible(venue({ cuisine: 'mexican' }), [noPork])).toBe(true);
  });
});
