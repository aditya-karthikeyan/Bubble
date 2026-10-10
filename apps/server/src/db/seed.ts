/**
 * Seed: five personas, their facts, the demo group centered on the hackathon address, and
 * every venue in data/venues.json. Idempotent upserts with stable ids, so running it again
 * (or on every boot) is safe and the demo reset can rely on it.
 */
import { eq } from 'drizzle-orm';
import { Fact as FactSchema, type Fact, type Group, type User } from '@bubbleworks/shared';
import { DEMO_GROUP, DEMO_MEMBERS, PERSONAS, PERSONA_FACTS } from '@bubbleworks/shared/fakes';
import type { Db } from './client.js';
import { facts, groupMembers, groups, users } from './schema.js';
import { DEMO_VENUE_ID, HACKATHON_CENTER } from '../venues/demo-venue.js';
import { loadVenuesFile, setVenuePhone, upsertVenues } from '../venues/repo.js';

export interface SeedOptions {
  venuesPath?: string;
  /** Teammate's number for the demo venue (DEMO_VENUE_PHONE). Placeholder stays when unset. */
  demoVenuePhone?: string | null;
  group?: Group;
  users?: User[];
  facts?: Fact[];
}

export interface SeedResult {
  users: number;
  facts: number;
  groups: number;
  members: number;
  venues: number;
}

export const SEED_GROUP: Group = { ...DEMO_GROUP, center: { ...HACKATHON_CENTER } };

export function seedDatabase(db: Db, options: SeedOptions = {}): SeedResult {
  const group = options.group ?? SEED_GROUP;
  const people = options.users ?? PERSONAS;
  const factList = options.facts ?? PERSONA_FACTS;

  db.transaction((tx) => {
    for (const u of people) {
      tx.insert(users)
        .values(u)
        .onConflictDoUpdate({
          target: users.id,
          set: { displayName: u.displayName, handle: u.handle, timezone: u.timezone },
        })
        .run();
    }
    for (const f of factList) {
      const { id: _id, ...rest } = f;
      tx.insert(facts).values(f).onConflictDoUpdate({ target: facts.id, set: rest }).run();
    }
    tx.insert(groups)
      .values({
        id: group.id,
        name: group.name,
        chatId: group.chatId,
        centerLat: group.center?.lat ?? null,
        centerLng: group.center?.lng ?? null,
        timezone: group.timezone,
        createdAt: group.createdAt,
      })
      .onConflictDoUpdate({
        target: groups.id,
        set: {
          name: group.name,
          chatId: group.chatId,
          centerLat: group.center?.lat ?? null,
          centerLng: group.center?.lng ?? null,
          timezone: group.timezone,
        },
      })
      .run();
    for (const m of DEMO_MEMBERS) {
      tx.insert(groupMembers)
        .values({ groupId: group.id, userId: m.userId, joinedAt: m.joinedAt })
        .onConflictDoNothing()
        .run();
    }
  });

  const venueList = loadVenuesFile(options.venuesPath);
  const venueCount = upsertVenues(db, venueList);
  if (options.demoVenuePhone) setVenuePhone(db, DEMO_VENUE_ID, options.demoVenuePhone);

  return {
    users: people.length,
    facts: factList.length,
    groups: 1,
    members: DEMO_MEMBERS.length,
    venues: venueCount,
  };
}

/** Hard and soft facts for a user straight from the facts table (Phase 1 BubbleService stand-in). */
export function factsForUser(db: Db, userId: string): Fact[] {
  return db
    .select()
    .from(facts)
    .where(eq(facts.userId, userId))
    .all()
    .map((r) => FactSchema.parse(r));
}

export function groupById(db: Db, groupId: string): Group | null {
  const row = db.select().from(groups).where(eq(groups.id, groupId)).get();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    chatId: row.chatId,
    center:
      row.centerLat !== null && row.centerLng !== null
        ? { lat: row.centerLat, lng: row.centerLng }
        : null,
    timezone: row.timezone,
    createdAt: row.createdAt,
  };
}

export function groupMemberIds(db: Db, groupId: string): string[] {
  return db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId))
    .all()
    .map((r) => r.userId);
}
