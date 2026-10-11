import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Runtime } from '../runtime.js';
import { TODAY, testRuntime } from '../test-helpers.js';
import { DEMO_VENUE_ID } from './demo-venue.js';

let rt: Runtime;
beforeEach(() => {
  rt = testRuntime();
});
afterEach(() => rt.close());

describe('CandidateIndex', () => {
  it('seeds the venue file and finds dinner candidates for the demo group', async () => {
    expect(rt.seed?.venues).toBeGreaterThanOrEqual(20);
    const set = await rt.candidates.forGroup({
      groupId: 'group_demo',
      date: TODAY,
      startMinutes: 19 * 60,
    });
    expect(set.fromCache).toBe(false);
    expect(set.venues.map((v) => v.id)).toContain(DEMO_VENUE_ID);
    // Every candidate is open Saturday 19:00 and vegetarian-capable (Ava and Chloe).
    for (const v of set.venues)
      expect(v.dietTags.some((t) => t === 'vegetarian' || t === 'vegan' || t === 'halal')).toBe(
        true,
      );
    const reasons = new Set(set.excluded.map((e) => e.reason));
    expect(reasons.has('incompatible')).toBe(true);
    expect(
      set.excluded.find((e) => e.reason === 'incompatible')?.detail?.[0]?.factTypes.length,
    ).toBeGreaterThan(0);
  });

  it('excludes venues closed at the requested time', async () => {
    const dinner = await rt.candidates.forGroup({
      groupId: 'group_demo',
      date: TODAY,
      startMinutes: 19 * 60,
      memberIds: ['user_dev'],
    });
    const lateNight = await rt.candidates.forGroup({
      groupId: 'group_demo',
      date: TODAY,
      startMinutes: 23 * 60 + 30,
      memberIds: ['user_dev'],
    });
    expect(lateNight.venues.length).toBeLessThan(dinner.venues.length);
    expect(lateNight.excluded.filter((e) => e.reason === 'closed').length).toBeGreaterThan(0);
  });

  it('narrows as members with hard facts are added', async () => {
    const dev = await rt.candidates.forGroup({
      groupId: 'group_demo',
      date: TODAY,
      memberIds: ['user_dev'],
    });
    const devBen = await rt.candidates.forGroup({
      groupId: 'group_demo',
      date: TODAY,
      memberIds: ['user_dev', 'user_ben'],
    });
    const all = await rt.candidates.forGroup({ groupId: 'group_demo', date: TODAY });
    expect(devBen.venues.length).toBeLessThanOrEqual(dev.venues.length);
    expect(all.venues.length).toBeLessThanOrEqual(devBen.venues.length);
    expect(all.venues.length).toBeGreaterThan(1);
  });

  it('caches per query and invalidates per group', async () => {
    await rt.candidates.forGroup({ groupId: 'group_demo', date: TODAY });
    const again = await rt.candidates.forGroup({ groupId: 'group_demo', date: TODAY });
    expect(again.fromCache).toBe(true);
    expect(rt.candidates.size()).toBe(1);
    rt.candidates.invalidate('group_other');
    expect(rt.candidates.size()).toBe(1);
    rt.candidates.invalidate('group_demo');
    expect(rt.candidates.size()).toBe(0);
    expect((await rt.candidates.forGroup({ groupId: 'group_demo', date: TODAY })).fromCache).toBe(
      false,
    );
  });

  it('excludes venues outside the radius', async () => {
    const set = await rt.candidates.forGroup({
      groupId: 'group_demo',
      date: TODAY,
      memberIds: ['user_dev'],
    });
    for (const v of set.venues) expect(v.location.lat).toBeGreaterThan(35.89);
    // Group center is Fetzer Gym; nothing in the file should be beyond 1.5 km + slack.
    expect(set.excluded.filter((e) => e.reason === 'too_far').length).toBeLessThanOrEqual(3);
  });
});

describe('seed pruning', () => {
  it('removes venues that left data/venues.json', async () => {
    const { upsertVenues, pruneVenues, listVenues } = await import('./repo.js');
    const { demoVenue } = await import('./demo-venue.js');
    const stale = { ...demoVenue(), id: 'venue_osm_stale', name: 'Closed Place' };
    upsertVenues(rt.db, [stale]);
    expect(listVenues(rt.db).some((v) => v.id === 'venue_osm_stale')).toBe(true);
    const removed = pruneVenues(
      rt.db,
      listVenues(rt.db)
        .filter((v) => v.id !== 'venue_osm_stale')
        .map((v) => v.id),
    );
    expect(removed).toBe(1);
    expect(listVenues(rt.db).some((v) => v.id === 'venue_osm_stale')).toBe(false);
  });
});
