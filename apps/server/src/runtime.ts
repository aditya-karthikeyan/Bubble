/**
 * Runtime: the database, event bus, timers, plan store, and candidate index wired together.
 * The HTTP app and every script build one of these.
 */
import type { Fact, Venue } from '@bubbleworks/shared';
import type { Config } from './config.js';
import { openDb, type DbHandle } from './db/client.js';
import {
  factsForUser,
  groupById,
  groupMemberIds,
  seedDatabase,
  type SeedResult,
} from './db/seed.js';
import { DbCrewDirectory } from './crew/directory.js';
import { PlanStore } from './engine/plan-store.js';
import { silentLogger, SqliteEventBus, type Logger } from './events/bus.js';
import { TimerService, type TimerServiceOptions } from './timers/service.js';
import { CandidateIndex } from './venues/candidates.js';
import { listVenues, upsertVenues } from './venues/repo.js';

export interface RuntimeOptions {
  /** Overrides config.DATABASE_PATH. ':memory:' for tests. */
  dbPath?: string;
  log?: Logger;
  seed?: boolean;
  venuesPath?: string;
  timers?: Omit<TimerServiceOptions, 'demoMode' | 'log'>;
  /** Phase 1 reads facts from the facts table. P3's BubbleService replaces this in Phase 3. */
  hardFacts?: (userId: string) => Promise<Fact[]>;
}

export interface Runtime {
  handle: DbHandle;
  db: DbHandle['db'];
  bus: SqliteEventBus;
  timers: TimerService;
  plans: PlanStore;
  candidates: CandidateIndex;
  crews: DbCrewDirectory;
  seed: SeedResult | null;
  log: Logger;
  /** Replace the hard-facts source (P3's BubbleService) and drop cached candidate sets. */
  setHardFacts(fn: (userId: string) => Promise<Fact[]>): void;
  venues(): Venue[];
  /** Live venues found for a plan join the table; caches are dropped. Returns the count. */
  addVenues(list: Venue[]): number;
  close(): void;
}

export function createRuntime(config: Config, options: RuntimeOptions = {}): Runtime {
  const log = options.log ?? silentLogger;
  const handle = openDb(options.dbPath ?? config.DATABASE_PATH);
  const { db } = handle;

  const seed =
    (options.seed ?? config.SEED_ON_BOOT)
      ? seedDatabase(db, {
          venuesPath: options.venuesPath,
          demoVenuePhone: config.DEMO_VENUE_PHONE ?? null,
        })
      : null;
  if (seed) log.info({ ...seed }, 'database seeded');

  const bus = new SqliteEventBus(db, { log });
  const timers = new TimerService(db, { demoMode: config.DEMO_MODE, log, ...options.timers });
  const plans = new PlanStore(db, bus, { log });
  const crews = new DbCrewDirectory(db);
  let venueCache: ReturnType<typeof listVenues> | null = null;
  // Late-bound so P3's BubbleService can replace the facts-table read after the runtime exists.
  const hardFactsRef = {
    fn: options.hardFacts ?? (async (userId: string) => factsForUser(db, userId)),
  };
  const candidates = new CandidateIndex({
    venues: () => (venueCache ??= listVenues(db)),
    group: (groupId) => groupById(db, groupId),
    memberIds: (groupId) => groupMemberIds(db, groupId),
    hardFacts: (userId) => hardFactsRef.fn(userId),
    log,
  });

  return {
    handle,
    db,
    bus,
    timers,
    plans,
    candidates,
    crews,
    seed,
    log,
    setHardFacts: (fn) => {
      hardFactsRef.fn = fn;
      candidates.invalidate();
    },
    venues: () => (venueCache ??= listVenues(db)),
    addVenues: (list) => {
      if (list.length === 0) return 0;
      const n = upsertVenues(db, list);
      venueCache = null;
      candidates.invalidate();
      return n;
    },
    close: () => {
      timers.stop();
      handle.close();
    },
  };
}
