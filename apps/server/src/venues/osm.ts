/**
 * Convert OpenStreetMap Overpass elements into Venues. Keeps only elements with a usable phone
 * number and parsable opening hours. Pure functions so the import is testable offline.
 */
import { Venue } from '@bubbleworks/shared';
import { z } from 'zod';
import { parseOpeningHours } from './hours.js';

export const OverpassElement = z.object({
  type: z.enum(['node', 'way', 'relation']),
  id: z.number(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).default({}),
});
export type OverpassElement = z.infer<typeof OverpassElement>;

export const OverpassResponse = z.object({ elements: z.array(OverpassElement) });

/** OSM cuisine values folded into the keys personas use (see personas.ts). */
const CUISINE_ALIASES: Record<string, string> = {
  burger: 'american',
  chicken: 'american',
  hot_dog: 'american',
  regional: 'american',
  southern: 'american',
  diner: 'american',
  barbecue: 'american',
  steak_house: 'american',
  coffee_shop: 'coffee',
  bubble_tea: 'coffee',
  tea: 'coffee',
  cafe: 'coffee',
  greek: 'mediterranean',
  turkish: 'mediterranean',
  lebanese: 'mediterranean',
  middle_eastern: 'mediterranean',
  italian: 'italian',
  japanese: 'sushi',
  noodle: 'ramen',
  salad: 'healthy',
  juice: 'healthy',
  sandwich: 'sandwich',
  bakery: 'sandwich',
  breakfast: 'breakfast',
};

const HALAL_CUISINES = new Set(['turkish', 'lebanese', 'pakistani', 'afghan', 'persian', 'kebab']);
const VEGETARIAN_FRIENDLY = new Set([
  'indian',
  'thai',
  'mexican',
  'pizza',
  'italian',
  'mediterranean',
  'healthy',
  'sandwich',
  'coffee',
  'vietnamese',
  'ethiopian',
]);
const VEGAN_FRIENDLY = new Set(['indian', 'healthy', 'ethiopian']);
const PRICIER_CUISINES = new Set(['sushi', 'seafood', 'steak_house', 'korean']);
const TYPICAL_COST: Record<number, number> = { 1: 12, 2: 22, 3: 38, 4: 60 };

export function normalizeCuisine(raw: string | undefined, amenity: string | undefined): string {
  const first = (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!first) return amenity === 'cafe' ? 'coffee' : 'other';
  return CUISINE_ALIASES[first] ?? first;
}

export function normalizePhone(raw: string | undefined): string | null {
  if (!raw) return null;
  const first = raw.split(';')[0]!.trim();
  const digits = first.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (first.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

export function dietTagsFor(tags: Record<string, string>, cuisine: string): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(tags)) {
    if (!k.startsWith('diet:')) continue;
    if (v !== 'yes' && v !== 'only') continue;
    const key = k.slice('diet:'.length).replace(/-/g, '_');
    if (['meat', 'non_vegetarian'].includes(key)) continue;
    out.add(key);
  }
  if (VEGETARIAN_FRIENDLY.has(cuisine)) out.add('vegetarian');
  if (VEGAN_FRIENDLY.has(cuisine)) out.add('vegan');
  if (HALAL_CUISINES.has(cuisine) || HALAL_CUISINES.has((tags['cuisine'] ?? '').split(';')[0]!)) {
    out.add('halal');
  }
  if (out.has('vegan')) out.add('vegetarian');
  return [...out].sort();
}

export function accessibilityTagsFor(tags: Record<string, string>): string[] {
  switch (tags['wheelchair']) {
    case 'yes':
      return ['wheelchair', 'step_free'];
    case 'limited':
      return ['step_free'];
    case 'no':
      return ['no_wheelchair'];
    default:
      return [];
  }
}

export function priceLevelFor(tags: Record<string, string>, cuisine: string): number {
  if (tags['amenity'] === 'fast_food' || tags['amenity'] === 'cafe') return 1;
  if (PRICIER_CUISINES.has(cuisine)) return 3;
  return 2;
}

export function addressFor(tags: Record<string, string>): string | null {
  const parts = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:city'],
    tags['addr:state'],
    tags['addr:postcode'],
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export interface Rejection {
  id: string;
  name: string;
  reason: 'no_name' | 'no_phone' | 'no_hours' | 'unparsable_hours' | 'no_location' | 'closed';
  raw?: string;
}

/** OSM marks a closed business with lifecycle prefixes or end dates; opening_hours may say off. */
export function looksClosed(tags: Record<string, string>): boolean {
  if (
    Object.keys(tags).some((k) =>
      /^(disused|was|abandoned|demolished|removed|razed|closed):/.test(k),
    )
  )
    return true;
  if (tags['end_date'] || tags['closed'] === 'yes' || tags['disused'] === 'yes') return true;
  const oh = (tags['opening_hours'] ?? '').trim().toLowerCase();
  return oh === 'off' || oh === 'closed';
}

export function elementToVenue(el: OverpassElement): { venue: Venue } | { rejection: Rejection } {
  const t = el.tags;
  const id = `venue_osm_${el.type[0]}${el.id}`;
  const name = t['name']?.trim() ?? '';
  if (!name) return { rejection: { id, name: '(unnamed)', reason: 'no_name' } };
  if (looksClosed(t)) return { rejection: { id, name, reason: 'closed' } };
  const phone = normalizePhone(t['phone'] ?? t['contact:phone']);
  if (!phone) return { rejection: { id, name, reason: 'no_phone' } };
  const rawHours = t['opening_hours'];
  if (!rawHours) return { rejection: { id, name, reason: 'no_hours' } };
  const hours = parseOpeningHours(rawHours);
  if (!hours) return { rejection: { id, name, reason: 'unparsable_hours', raw: rawHours } };
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat === undefined || lng === undefined) {
    return { rejection: { id, name, reason: 'no_location' } };
  }
  const cuisine = normalizeCuisine(t['cuisine'], t['amenity']);
  const priceLevel = priceLevelFor(t, cuisine);
  const venue = Venue.parse({
    id,
    name,
    cuisine,
    dietTags: dietTagsFor(t, cuisine),
    accessibilityTags: accessibilityTagsFor(t),
    priceLevel,
    typicalCostUsd: TYPICAL_COST[priceLevel] ?? 22,
    hours,
    phone,
    location: { lat, lng },
    address: addressFor(t),
    neighborhood: t['addr:suburb'] ?? t['addr:neighbourhood'] ?? null,
    isDemo: false,
  });
  return { venue };
}

export function convertOverpass(json: unknown): { venues: Venue[]; rejections: Rejection[] } {
  const parsed = OverpassResponse.parse(json);
  const venues: Venue[] = [];
  const rejections: Rejection[] = [];
  for (const el of parsed.elements) {
    const r = elementToVenue(el);
    if ('venue' in r) venues.push(r.venue);
    else rejections.push(r.rejection);
  }
  venues.sort((a, b) => a.id.localeCompare(b.id));
  return { venues, rejections };
}
