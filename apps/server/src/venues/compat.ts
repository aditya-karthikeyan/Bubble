/**
 * Hard-fact compatibility between a venue and one member's facts. Deterministic rules only.
 *
 * ASSUMPTIONS:
 * 1. A religious diet is satisfiable at a venue that can serve a compatible vegetarian or vegan
 *    meal, because OSM rarely tags halal/kosher. Tagged halal/kosher venues qualify directly.
 * 2. Allergies exclude venues whose cuisine is high risk for that allergen unless the venue tags
 *    `<allergen>_free`. Other venues pass; the caller mentions table-level allergy notes.
 * 3. Wheelchair: only an explicit `no_wheelchair` tag excludes. Unknown status passes, since
 *    most OSM venues carry no wheelchair tag, and the caller confirms access on the call.
 * Budget is a hard fact too, but it is relaxable, so the solver (Phase 2) applies it, not the
 * candidate precompute.
 */
import type { Fact, Venue } from '@bubbleworks/shared';

export const ALLERGEN_RISK_CUISINES: Record<string, readonly string[]> = {
  peanut: ['thai', 'vietnamese', 'chinese', 'asian', 'indonesian', 'malaysian', 'african'],
  tree_nut: ['thai', 'indian', 'persian', 'middle_eastern'],
  shellfish: ['sushi', 'seafood', 'cajun', 'thai', 'chinese', 'asian'],
  dairy: ['pizza', 'italian', 'indian', 'ice_cream', 'dessert'],
  gluten: ['pizza', 'italian', 'sandwich', 'bakery', 'ramen'],
  soy: ['sushi', 'chinese', 'korean', 'asian', 'ramen', 'vietnamese'],
  egg: ['ramen', 'bakery', 'breakfast'],
  sesame: ['middle_eastern', 'mediterranean', 'chinese', 'asian', 'korean'],
};

/**
 * Meat-centric kitchens where "no pork" / "no beef" is not a safe bet even with a veg option.
 * Matched against the raw OSM cuisine tags and the folded cuisine key.
 */
const PORK_HEAVY = new Set(['hot_dog', 'bbq', 'barbecue', 'german', 'pork', 'ribs', 'sausage']);
const BEEF_HEAVY = new Set([
  'burger',
  'hot_dog',
  'steak_house',
  'steak',
  'bbq',
  'barbecue',
  'kbbq',
  'korean_bbq',
]);
const MEAT_EXCLUSIONS: Record<string, ReadonlySet<string>> = {
  no_pork: PORK_HEAVY,
  no_beef: BEEF_HEAVY,
  no_red_meat: new Set([...PORK_HEAVY, ...BEEF_HEAVY, 'lamb']),
};

const DIET_SATISFIED_BY: Record<string, readonly string[]> = {
  vegetarian: ['vegetarian', 'vegan'],
  vegan: ['vegan'],
  pescatarian: ['vegetarian', 'vegan', 'pescatarian', 'seafood'],
  gluten_free: ['gluten_free'],
  dairy_free: ['dairy_free', 'vegan'],
};

const RELIGIOUS_SATISFIED_BY: Record<string, readonly string[]> = {
  halal: ['halal', 'vegetarian', 'vegan'],
  kosher: ['kosher', 'vegan'],
  hindu_veg: ['vegetarian', 'vegan'],
  jain: ['vegan', 'jain'],
};

export interface Incompatibility {
  factType: Fact['type'];
  value: string;
  reason: string;
}

/** Null when the venue works for this fact, otherwise why not. */
export function checkHardFact(venue: Venue, fact: Fact): Incompatibility | null {
  const tags = new Set(venue.dietTags);
  switch (fact.type) {
    case 'diet': {
      const excluded = MEAT_EXCLUSIONS[fact.value];
      if (excluded) {
        const kitchen = [venue.cuisine, ...(venue.cuisineTags ?? [])];
        const risky = kitchen.some((c) => excluded.has(c));
        return risky
          ? { factType: fact.type, value: fact.value, reason: 'meat_heavy_kitchen' }
          : null;
      }
      const ok = (DIET_SATISFIED_BY[fact.value] ?? [fact.value]).some((t) => tags.has(t));
      return ok ? null : { factType: fact.type, value: fact.value, reason: 'no_diet_option' };
    }
    case 'religious_diet': {
      const ok = (RELIGIOUS_SATISFIED_BY[fact.value] ?? [fact.value]).some((t) => tags.has(t));
      return ok ? null : { factType: fact.type, value: fact.value, reason: 'no_religious_option' };
    }
    case 'allergy': {
      if (tags.has(`${fact.value}_free`)) return null;
      const risky = (ALLERGEN_RISK_CUISINES[fact.value] ?? []).includes(venue.cuisine);
      return risky ? { factType: fact.type, value: fact.value, reason: 'allergen_risk' } : null;
    }
    case 'accessibility': {
      const access = new Set(venue.accessibilityTags);
      if (fact.value === 'wheelchair' || fact.value === 'step_free') {
        return access.has('no_wheelchair')
          ? { factType: fact.type, value: fact.value, reason: 'not_accessible' }
          : null;
      }
      return null;
    }
    default:
      // budget_max and soft facts are the solver's business.
      return null;
  }
}

/** Every hard, non-budget fact that rules this venue out for the member. */
export function incompatibilities(venue: Venue, facts: Fact[]): Incompatibility[] {
  const out: Incompatibility[] = [];
  for (const fact of facts) {
    if (!fact.hard) continue;
    const bad = checkHardFact(venue, fact);
    if (bad) out.push(bad);
  }
  return out;
}

export function isCompatible(venue: Venue, facts: Fact[]): boolean {
  return incompatibilities(venue, facts).length === 0;
}
