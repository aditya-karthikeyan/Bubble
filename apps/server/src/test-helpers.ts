import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { createRuntime, type Runtime, type RuntimeOptions } from './runtime.js';

export const VENUES_FIXTURE = resolve(import.meta.dirname, '../../../data/venues.json');

/** In-memory runtime with the seed applied and a controllable clock. */
export function testRuntime(options: RuntimeOptions = {}): Runtime {
  const config = loadConfig({ NODE_ENV: 'test', SEED_ON_BOOT: 'true', DEMO_MODE: 'false' });
  return createRuntime(config, {
    dbPath: ':memory:',
    seed: true,
    venuesPath: VENUES_FIXTURE,
    ...options,
  });
}

export const TODAY = '2026-10-10';
export const INTENT = {
  meal: 'dinner' as const,
  date: TODAY,
  startMinutes: 19 * 60,
  cuisine: null,
  rawText: 'dinner today?',
};
