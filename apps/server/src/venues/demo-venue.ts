/**
 * The demo venue rings a teammate's phone during rehearsals. Its number lives in
 * DEMO_VENUE_PHONE (local .env and Railway variables), never in the repo: data/venues.json
 * carries a placeholder that the seed replaces at boot.
 */
import type { Venue } from '@bubbleworks/shared';
import { allWeek } from './hours.js';

export const DEMO_VENUE_ID = 'venue_demo';
export const DEMO_VENUE_PHONE_PLACEHOLDER = '+10000000000';

/** Fetzer Gym, Chapel Hill (the hackathon address). */
export const HACKATHON_CENTER = { lat: 35.9097, lng: -79.0475 } as const;

export function demoVenue(phone: string = DEMO_VENUE_PHONE_PLACEHOLDER): Venue {
  return {
    id: DEMO_VENUE_ID,
    name: 'The Demo Table',
    cuisine: 'american',
    dietTags: ['vegetarian', 'vegan', 'halal', 'gluten_free', 'peanut_free'],
    accessibilityTags: ['wheelchair', 'step_free'],
    priceLevel: 2,
    typicalCostUsd: 18,
    hours: allWeek({ open: 11 * 60, close: 23 * 60 }),
    phone,
    location: { lat: 35.9101, lng: -79.0481 },
    address: 'South Rd, Chapel Hill, NC 27514',
    neighborhood: 'UNC campus',
    isDemo: true,
  };
}
