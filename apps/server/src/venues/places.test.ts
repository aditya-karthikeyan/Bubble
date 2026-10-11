import { describe, expect, it } from 'vitest';
import { GooglePlacesSource, cuisineFromTypes, hoursFromPeriods, placeToVenue } from './places.js';
import { openDb } from '../db/client.js';
import { listVenues, pruneVenues, upsertVenues } from './repo.js';

const PLACE = {
  id: 'ChIJabc',
  displayName: { text: 'Wheat' },
  formattedAddress: '125 E Franklin St, Chapel Hill',
  location: { latitude: 35.9132, longitude: -79.0558 },
  internationalPhoneNumber: '+1 919-555-0101',
  regularOpeningHours: {
    periods: [
      { open: { day: 1, hour: 11, minute: 0 }, close: { day: 1, hour: 21, minute: 30 } },
      { open: { day: 5, hour: 17, minute: 0 }, close: { day: 6, hour: 1, minute: 0 } },
    ],
  },
  priceLevel: 'PRICE_LEVEL_MODERATE',
  rating: 4.6,
  userRatingCount: 812,
  reservable: true,
  servesVegetarianFood: true,
  primaryType: 'chinese_restaurant',
  types: ['chinese_restaurant', 'restaurant', 'food'],
  businessStatus: 'OPERATIONAL',
  dineIn: true,
};

describe('Google Places mapping', () => {
  it('maps a place to a bookable venue', () => {
    const v = placeToVenue(PLACE, 'chinese')!;
    expect(v.id).toBe('venue_gp_ChIJabc');
    expect(v.cuisine).toBe('chinese');
    expect(v.style).toBe('sit_down');
    expect(v.phone).toBe('+19195550101');
    expect(v.typicalCostUsd).toBe(22);
    expect(v.dietTags).toContain('vegetarian');
    expect(v.rating).toBe(4.6);
    expect(v.ratingCount).toBe(812);
    expect(v.hours[1]).toEqual([{ open: 660, close: 1290 }]);
    // Friday 5 PM to 1 AM Saturday is one interval that runs past midnight.
    expect(v.hours[5]).toEqual([{ open: 1020, close: 1500 }]);
  });

  it('rejects places that cannot be booked', () => {
    expect(placeToVenue({ ...PLACE, internationalPhoneNumber: undefined }, 'chinese')).toBeNull();
    expect(placeToVenue({ ...PLACE, regularOpeningHours: undefined }, 'chinese')).toBeNull();
    expect(placeToVenue({ ...PLACE, businessStatus: 'CLOSED_TEMPORARILY' }, 'chinese')).toBeNull();
  });

  it('reads cuisine and style from the types', () => {
    expect(cuisineFromTypes('restaurant', ['restaurant'], 'indian')).toBe('indian');
    expect(cuisineFromTypes('middle_eastern_restaurant', [], null)).toBe('middle_eastern');
    expect(cuisineFromTypes('hamburger_restaurant', [], null)).toBe('american');
    const fast = placeToVenue(
      {
        ...PLACE,
        primaryType: 'fast_food_restaurant',
        types: ['fast_food_restaurant', 'restaurant', 'food'],
      },
      null,
    )!;
    expect(fast.style).toBe('fast_food');
    // A "restaurant" that says it does not take reservations is not a place you book.
    expect(placeToVenue({ ...PLACE, reservable: false }, null)!.style).toBe('fast_food');
    expect(hoursFromPeriods([])).toBeNull();
  });

  it('searches once per area and cuisine and sends the key in a header', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ places: [PLACE, { id: 'nophone' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const source = new GooglePlacesSource({ apiKey: 'test-key', fetch: fakeFetch });
    const q = {
      center: { lat: 35.9097, lng: -79.0475 },
      radiusM: 4800,
      cuisine: 'chinese',
      meal: 'dinner' as const,
    };
    const first = await source.search(q);
    const second = await source.search(q);
    expect(first.map((v) => v.name)).toEqual(['Wheat']);
    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe('test-key');
    expect(headers['X-Goog-FieldMask']).toContain('places.regularOpeningHours');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.textQuery).toBe('chinese restaurant');
    expect(body.locationBias.circle.radius).toBe(4800);
  });

  it('survives the seed prune, so a plan locked on a live venue outlives a restart', () => {
    const handle = openDb(':memory:');
    const db = handle.db;
    const live = placeToVenue(PLACE, 'chinese')!;
    const seeded = { ...live, id: 'venue_osm_1', name: 'Seeded' };
    const stale = { ...live, id: 'venue_osm_2', name: 'Closed since' };
    upsertVenues(db, [live, seeded, stale]);
    pruneVenues(db, [seeded.id]);
    expect(
      listVenues(db)
        .map((v) => v.id)
        .sort(),
    ).toEqual([live.id, seeded.id]);
    handle.close();
  });
});
