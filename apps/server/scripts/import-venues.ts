/**
 * pnpm --filter @bubbleworks/server venues:import [raw-overpass.json]
 *
 * Pulls restaurants, fast food, and cafes within VENUE_RADIUS_M of the hackathon address from
 * the Overpass API (or converts a saved response), keeps those with a phone and parsable hours,
 * adds the demo venue, and writes data/venues.json at the repo root.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VENUE_RADIUS_M } from '@bubbleworks/shared';
import { demoVenue, HACKATHON_CENTER } from '../src/venues/demo-venue.js';
import { convertOverpass } from '../src/venues/osm.js';

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const OUT = resolve(import.meta.dirname, '../../../data/venues.json');

/**
 * Venues OSM still lists that are gone or moved. Checked 2026-10-11 against local news; keep the
 * reason so the next import can re-check. The caller must never ring a dead number.
 */
const REMOVED: Record<string, string> = {
  venue_osm_n3316380639: "[B]SKI'S The Wrap Redefined closed January 2019 (Daily Tar Heel)",
  venue_osm_w44343001: "Mama Dip's Kitchen closed permanently 22 July 2025 (Chapelboro, ABC11)",
  venue_osm_n2763321664:
    'Kipos Greek Taverna moved to Eastgate Crossing in 2020; OSM pin is the old Franklin St spot',
};

async function fetchOverpass(): Promise<unknown> {
  const { lat, lng } = HACKATHON_CENTER;
  const query = `[out:json][timeout:120];(nwr["amenity"~"^(restaurant|fast_food|cafe)$"](around:${VENUE_RADIUS_M},${lat},${lng}););out center tags;`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    for (const mirror of MIRRORS) {
      try {
        const res = await fetch(mirror, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'user-agent': 'bubbleworks-hackathon/0.1',
          },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(150_000),
        });
        const text = await res.text();
        if (!text.trimStart().startsWith('{')) throw new Error(`${mirror}: non-JSON response`);
        console.log(`fetched from ${mirror} (attempt ${attempt})`);
        return JSON.parse(text) as unknown;
      } catch (err) {
        lastError = err;
        console.warn(`  ${mirror} failed: ${(err as Error).message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  throw lastError instanceof Error ? lastError : new Error('Overpass unavailable');
}

async function main(): Promise<void> {
  const rawPath = process.argv[2];
  const raw: unknown = rawPath
    ? (JSON.parse(readFileSync(resolve(rawPath), 'utf8')) as unknown)
    : await fetchOverpass();

  const { venues: converted, rejections } = convertOverpass(raw);
  const venues = converted.filter((v) => {
    const why = REMOVED[v.id];
    if (why) console.log(`  removed: ${v.name}: ${why}`);
    return !why;
  });
  const all = [demoVenue(), ...venues];
  writeFileSync(OUT, `${JSON.stringify(all, null, 2)}\n`);

  const byReason = new Map<string, number>();
  for (const r of rejections) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  console.log(`kept ${venues.length} OSM venues + 1 demo venue -> ${OUT}`);
  console.log(`rejected ${rejections.length}:`, Object.fromEntries(byReason));
  for (const r of rejections.filter((x) => x.reason === 'unparsable_hours')) {
    console.log(`  unparsable hours: ${r.name}: ${r.raw}`);
  }
  for (const v of all) {
    console.log(
      `  ${v.id.padEnd(22)} ${v.name.padEnd(30)} ${v.cuisine.padEnd(14)} $${v.typicalCostUsd} ${v.dietTags.join(',')}`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
