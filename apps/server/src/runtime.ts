/**
 * Runtime: the database, event bus, timers, plan store, and candidate index wired together.
 * The HTTP app and every script build one of these.
 */
import type { Fact } from '@bubbleworks/shared';
import type { Config } from './config.js';
import { openDb, type DbHandle } from './db/client.js';
import {
  factsForUser,
  groupById,
  groupMemberIds,
  seedDatabase,
  type SeedResult,
} from './db/seed.js';
import { PlanStore } from './engine/plan-store.js';
import { silentLogger, SqliteEventBus, type Logger } from './events/bus.js';
import { TimerService, type TimerServiceOptions } from './timers/service.js';
import { CandidateIndex } from './venues/candidates.js';
import { listVenues } from './venues/repo.js';

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
  seed: SeedResult | null;
  log: Logger;
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
  let venueCache: ReturnType<typeof listVenues> | null = null;
  const candidates = new CandidateIndex({
    venues: () => (venueCache ??= listVenues(db)),
    group: (groupId) => groupById(db, groupId),
    memberIds: (groupId) => groupMemberIds(db, groupId),
    hardFacts: options.hardFacts ?? (async (userId) => factsForUser(db, userId)),
    log,
  });

  return {
    handle,
    db,
    bus,
    timers,
    plans,
    candidates,
    seed,
    log,
    close: () => {
      timers.stop();
      handle.close();
    },
  };
}
