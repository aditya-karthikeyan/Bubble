/**
 * Five seeded personas and one group with stable ids. The Phase 1 seed script and every
 * fake use these, so simulations and the demo reset agree.
 */
import { crewChatId, type Fact, type Group, type GroupMember, type User } from '../types.js';

const T0 = '2026-10-10T12:00:00.000Z';

export const DEMO_GROUP: Group = {
  id: 'group_demo',
  name: 'the usual suspects',
  chatId: crewChatId('group_demo'),
  status: 'active',
  createdByUserId: 'user_ava',
  // Fetzer Gym, Chapel Hill (the hackathon address).
  center: { lat: 35.9097, lng: -79.0475 },
  timezone: 'America/New_York',
  createdAt: T0,
};

export const PERSONAS: User[] = [
  {
    id: 'user_ava',
    displayName: 'Ava',
    handle: '+10000000001',
    email: null,
    bubbleNumber: null,
    onboardedAt: T0,
    timezone: 'America/New_York',
    createdAt: T0,
  },
  {
    id: 'user_ben',
    displayName: 'Ben',
    handle: '+10000000002',
    email: null,
    bubbleNumber: null,
    onboardedAt: T0,
    timezone: 'America/New_York',
    createdAt: T0,
  },
  {
    id: 'user_chloe',
    displayName: 'Chloe',
    handle: '+10000000003',
    email: null,
    bubbleNumber: null,
    onboardedAt: T0,
    timezone: 'America/New_York',
    createdAt: T0,
  },
  {
    id: 'user_dev',
    displayName: 'Dev',
    handle: '+10000000004',
    email: null,
    bubbleNumber: null,
    onboardedAt: T0,
    timezone: 'America/New_York',
    createdAt: T0,
  },
  {
    id: 'user_eli',
    displayName: 'Eli',
    handle: '+10000000005',
    email: null,
    bubbleNumber: null,
    onboardedAt: T0,
    timezone: 'America/New_York',
    createdAt: T0,
  },
];

export const DEMO_MEMBERS: GroupMember[] = PERSONAS.map((u) => ({
  groupId: DEMO_GROUP.id,
  userId: u.id,
  joinedAt: T0,
  confirmedAt: T0,
}));

function fact(
  id: string,
  userId: string,
  type: Fact['type'],
  value: string,
  hard: boolean,
  extra: Partial<Fact> = {},
): Fact {
  return {
    id,
    userId,
    type,
    value,
    hard,
    confidence: 1,
    source: 'onboarding',
    confirmed: true,
    expiresAt: null,
    createdAt: T0,
    ...extra,
  };
}

/**
 * Ava: vegetarian, budget 25, loves thai and indian, lives near Franklin St.
 * Ben: peanut allergy (hard), budget 40, loves burgers, avoids sushi.
 * Chloe: halal (hard), budget 20, loves mediterranean.
 * Dev: no limits, budget 50, loves ramen and korean, has a favorite spot.
 * Eli: wheelchair access (hard), budget 30, avoids spicy / thai, loves pizza.
 */
export const PERSONA_FACTS: Fact[] = [
  fact('fact_ava_diet', 'user_ava', 'diet', 'vegetarian', true),
  fact('fact_ava_budget', 'user_ava', 'budget_max', '25', true),
  fact('fact_ava_like_thai', 'user_ava', 'cuisine_like', 'thai', false),
  fact('fact_ava_like_indian', 'user_ava', 'cuisine_like', 'indian', false),
  fact('fact_ava_hood', 'user_ava', 'neighborhood', 'Franklin St', false),
  fact('fact_ava_venmo', 'user_ava', 'venmo_handle', '@ava-demo', false),

  fact('fact_ben_allergy', 'user_ben', 'allergy', 'peanut', true),
  fact('fact_ben_budget', 'user_ben', 'budget_max', '40', true),
  fact('fact_ben_like_burgers', 'user_ben', 'cuisine_like', 'american', false),
  fact('fact_ben_avoid_sushi', 'user_ben', 'cuisine_avoid', 'sushi', false),
  fact('fact_ben_venmo', 'user_ben', 'venmo_handle', '@ben-demo', false),

  fact('fact_chloe_religious', 'user_chloe', 'religious_diet', 'halal', true),
  fact('fact_chloe_budget', 'user_chloe', 'budget_max', '20', true),
  fact('fact_chloe_like_med', 'user_chloe', 'cuisine_like', 'mediterranean', false),
  fact('fact_chloe_venmo', 'user_chloe', 'venmo_handle', '@chloe-demo', false),

  fact('fact_dev_budget', 'user_dev', 'budget_max', '50', true),
  fact('fact_dev_like_ramen', 'user_dev', 'cuisine_like', 'ramen', false),
  fact('fact_dev_like_korean', 'user_dev', 'cuisine_like', 'korean', false),
  fact('fact_dev_fav', 'user_dev', 'favorite_venue', 'venue_demo', false),
  fact('fact_dev_venmo', 'user_dev', 'venmo_handle', '@dev-demo', false),

  fact('fact_eli_access', 'user_eli', 'accessibility', 'wheelchair', true),
  fact('fact_eli_budget', 'user_eli', 'budget_max', '30', true),
  fact('fact_eli_avoid_thai', 'user_eli', 'cuisine_avoid', 'thai', false),
  fact('fact_eli_like_pizza', 'user_eli', 'cuisine_like', 'pizza', false),
  fact('fact_eli_venmo', 'user_eli', 'venmo_handle', '@eli-demo', false),
];

export function factsFor(userId: string): Fact[] {
  return PERSONA_FACTS.filter((f) => f.userId === userId);
}

export function personaById(userId: string): User | undefined {
  return PERSONAS.find((u) => u.id === userId);
}
