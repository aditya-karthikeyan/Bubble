/**
 * Live venues from Google Places API (New). Owner: P1.
 *
 * One text search per plan ("chinese restaurant" near the crew's center, within reach). Results
 * are upserted into the venues table so the solver, the live page, and the caller see them like
 * any other venue. Needs GOOGLE_PLACES_KEY; without it the stored venues stand. Nothing here is
 * hardcoded: the list is whatever Google returns for that place at that moment.
 */
import { Venue, type GeoPoint, type MealKind, type WeeklyHours } from '@bubbleworks/shared';
import type { Logger } from '../events/bus.js';
import { dietTagsFor, normalizePhone } from './osm.js';
import { LIVE_VENUE_PREFIX } from './repo.js';

export interface VenueSearch {
  center: GeoPoint;
  radiusM: number;
  /** Lowercase cuisine key from the message ("chinese"), or null for any restaurant. */
  cuisine: string | null;
  meal: MealKind | null;
}

export interface VenueSource {
  search(query: VenueSearch): Promise<Venue[]>;
}

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.internationalPhoneNumber',
  'places.nationalPhoneNumber',
  'places.regularOpeningHours',
  'places.priceLevel',
  'places.rating',
  'places.userRatingCount',
  'places.reservable',
  'places.servesVegetarianFood',
  'places.primaryType',
  'places.types',
  'places.businessStatus',
  'places.dineIn',
].join(',');

const PRICE: Record<string, number> = {
  PRICE_LEVEL_FREE: 1,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};
const TYPICAL_COST: Record<number, number> = { 1: 12, 2: 22, 3: 38, 4: 60 };

/** Counter service, takeout, and coffee: not places you book. */
const FAST_TYPES = new Set([
  'fast_food_restaurant',
  'meal_takeaway',
  'meal_delivery',
  'sandwich_shop',
  'hamburger_restaurant',
  'coffee_shop',
  'cafe',
  'bakery',
  'ice_cream_shop',
  'juice_shop',
  'dessert_shop',
  'donut_shop',
  'bagel_shop',
]);

const TYPE_CUISINE: Record<string, string> = {
  american_restaurant: 'american',
  hamburger_restaurant: 'american',
  barbecue_restaurant: 'american',
  diner: 'american',
  steak_house: 'steak_house',
  seafood_restaurant: 'seafood',
  pizza_restaurant: 'pizza',
  sushi_restaurant: 'sushi',
  ramen_restaurant: 'japanese',
  sandwich_shop: 'sandwich',
  coffee_shop: 'coffee',
  cafe: 'coffee',
  vegetarian_restaurant: 'healthy',
  vegan_restaurant: 'healthy',
  breakfast_restaurant: 'american',
  brunch_restaurant: 'american',
};

/** "chinese_restaurant" -> "chinese"; a bare "restaurant" takes the cuisine that was asked for. */
export function cuisineFromTypes(
  primaryType: string | undefined,
  types: string[] | undefined,
  asked: string | null,
): string {
  for (const t of [primaryType, ...(types ?? [])]) {
    if (!t) continue;
    const mapped = TYPE_CUISINE[t];
    if (mapped) return mapped;
    const m = /^([a-z_]+)_restaurant$/.exec(t);
    if (m && m[1] && !['fast_food', 'fine_dining', 'buffet', 'family'].includes(m[1])) return m[1];
  }
  return asked ?? 'other';
}

interface PlacePeriodPoint {
  day: number;
  hour: number;
  minute: number;
}

export interface Place {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  internationalPhoneNumber?: string;
  nationalPhoneNumber?: string;
  regularOpeningHours?: { periods?: Array<{ open: PlacePeriodPoint; close?: PlacePeriodPoint }> };
  priceLevel?: string;
  rating?: number;
  userRatingCount?: number;
  reservable?: boolean;
  servesVegetarianFood?: boolean;
  primaryType?: string;
  types?: string[];
  businessStatus?: string;
  dineIn?: boolean;
}

/** Google's periods (Sunday = 0, close may fall on the next day) to our weekly minutes. */
export function hoursFromPeriods(
  periods: Array<{ open: PlacePeriodPoint; close?: PlacePeriodPoint }> | undefined,
): WeeklyHours | null {
  if (!periods?.length) return null;
  const week: WeeklyHours = [[], [], [], [], [], [], []];
  for (const p of periods) {
    const day = p.open.day;
    if (day < 0 || day > 6) continue;
    const open = p.open.hour * 60 + p.open.minute;
    let close = 1440;
    if (p.close) {
      const c = p.close.hour * 60 + p.close.minute;
      close = p.close.day === day ? c : Math.min(1440 + c, 1440 + 6 * 60);
      if (close <= open) close = 1440;
    }
    week[day]!.push({ open, close });
  }
  return week.some((d) => d.length) ? week : null;
}

/** One Google place to a Venue, or null when it cannot be booked (no phone, no hours, closed). */
export function placeToVenue(place: Place, asked: string | null): Venue | null {
  if (place.businessStatus && place.businessStatus !== 'OPERATIONAL') return null;
  const phone = normalizePhone(place.internationalPhoneNumber ?? place.nationalPhoneNumber);
  const hours = hoursFromPeriods(place.regularOpeningHours?.periods);
  if (!phone || !hours || !place.location || !place.displayName?.text) return null;
  const cuisine = cuisineFromTypes(place.primaryType, place.types, asked);
  // Places you book: Google says reservable. Counter service, takeout, and anything that says it
  // does not take reservations is fast_food, so a dinner plan never calls a taco counter.
  const types = new Set([place.primaryType ?? '', ...(place.types ?? [])]);
  const fast = [...types].some((t) => FAST_TYPES.has(t));
  const style =
    place.reservable === true && !fast
      ? 'sit_down'
      : fast || place.dineIn === false || place.reservable === false
        ? 'fast_food'
        : 'sit_down';
  const priceLevel = PRICE[place.priceLevel ?? ''] ?? 2;
  const dietTags = new Set(dietTagsFor({}, cuisine));
  if (place.servesVegetarianFood) dietTags.add('vegetarian');
  return Venue.parse({
    id: `${LIVE_VENUE_PREFIX}${place.id}`,
    name: place.displayName.text,
    cuisine,
    cuisineTags: [place.primaryType ?? cuisine],
    style,
    dietTags: [...dietTags].sort(),
    accessibilityTags: [],
    priceLevel,
    typicalCostUsd: TYPICAL_COST[priceLevel] ?? 22,
    hours,
    phone,
    location: { lat: place.location.latitude, lng: place.location.longitude },
    address: place.formattedAddress ?? null,
    neighborhood: null,
    isDemo: false,
    rating: typeof place.rating === 'number' ? place.rating : null,
    ratingCount: typeof place.userRatingCount === 'number' ? place.userRatingCount : null,
  });
}

export interface GooglePlacesOptions {
  apiKey: string;
  fetch?: typeof fetch;
  log?: Logger;
  /** Reuse a search for this long; a crew asking twice in a row gets the same list. */
  cacheMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export class GooglePlacesSource implements VenueSource {
  private readonly cache = new Map<string, { at: number; venues: Venue[] }>();

  constructor(private readonly o: GooglePlacesOptions) {}

  async search(q: VenueSearch): Promise<Venue[]> {
    const now = this.o.now ?? Date.now;
    const key = `${q.center.lat.toFixed(3)},${q.center.lng.toFixed(3)}:${q.radiusM}:${q.cuisine ?? '*'}:${q.meal ?? '*'}`;
    const hit = this.cache.get(key);
    if (hit && now() - hit.at < (this.o.cacheMs ?? 10 * 60_000)) return hit.venues;

    const what = q.meal === 'coffee' ? 'coffee shop' : 'restaurant';
    const textQuery = q.cuisine ? `${q.cuisine.replace(/_/g, ' ')} ${what}` : what;
    const body = {
      textQuery,
      includedType: q.meal === 'coffee' ? 'cafe' : 'restaurant',
      pageSize: 20,
      locationBias: {
        circle: {
          center: { latitude: q.center.lat, longitude: q.center.lng },
          radius: Math.min(Math.max(q.radiusM, 500), 50_000),
        },
      },
    };
    const t0 = now();
    const res = await (this.o.fetch ?? fetch)(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.o.apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 6_000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`places ${res.status}: ${text}`);
    }
    const json = (await res.json()) as { places?: Place[] };
    const venues: Venue[] = [];
    let rejected = 0;
    for (const p of json.places ?? []) {
      const v = placeToVenue(p, q.cuisine);
      if (v) venues.push(v);
      else rejected += 1;
    }
    this.o.log?.info(
      { textQuery, found: venues.length, rejected, ms: now() - t0 },
      'google places search',
    );
    this.cache.set(key, { at: now(), venues });
    return venues;
  }
}
