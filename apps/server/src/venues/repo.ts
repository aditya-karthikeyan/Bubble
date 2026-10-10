/**
 * Venues: load data/venues.json, upsert into the venues table, and read back as Venue.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { Venue as VenueSchema, type Venue } from '@bubbleworks/shared';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { venues } from '../db/schema.js';

export const DEFAULT_VENUES_PATH = resolve(import.meta.dirname, '../../../../data/venues.json');

export function loadVenuesFile(path: string = DEFAULT_VENUES_PATH): Venue[] {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return z.array(VenueSchema).parse(raw);
}

export function upsertVenues(db: Db, list: Venue[]): number {
  let count = 0;
  db.transaction((tx) => {
    for (const v of list) {
      const row: typeof venues.$inferInsert = {
        id: v.id,
        name: v.name,
        cuisine: v.cuisine,
        dietTags: v.dietTags,
        accessibilityTags: v.accessibilityTags,
        priceLevel: v.priceLevel,
        typicalCostUsd: v.typicalCostUsd,
        hours: v.hours,
        phone: v.phone,
        lat: v.location.lat,
        lng: v.location.lng,
        address: v.address,
        neighborhood: v.neighborhood,
        isDemo: v.isDemo,
      };
      const { id: _id, ...rest } = row;
      tx.insert(venues).values(row).onConflictDoUpdate({ target: venues.id, set: rest }).run();
      count += 1;
    }
  });
  return count;
}

export function listVenues(db: Db): Venue[] {
  return db.select().from(venues).all().map(toVenue);
}

export function getVenue(db: Db, id: string): Venue | null {
  const row = db.select().from(venues).where(eq(venues.id, id)).get();
  return row ? toVenue(row) : null;
}

export function setVenuePhone(db: Db, id: string, phone: string): void {
  db.update(venues).set({ phone }).where(eq(venues.id, id)).run();
}

export function toVenue(row: typeof venues.$inferSelect): Venue {
  return VenueSchema.parse({
    id: row.id,
    name: row.name,
    cuisine: row.cuisine,
    dietTags: row.dietTags,
    accessibilityTags: row.accessibilityTags,
    priceLevel: row.priceLevel,
    typicalCostUsd: row.typicalCostUsd,
    hours: row.hours,
    phone: row.phone,
    location: { lat: row.lat, lng: row.lng },
    address: row.address,
    neighborhood: row.neighborhood,
    isDemo: row.isDemo,
  });
}
