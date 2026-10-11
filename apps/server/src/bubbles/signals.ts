/**
 * Context signals: Find My location, Google free/busy, presence. Owner: P3.
 *
 * Photon Find My calls take 5 to 7 s and Google free/busy ~200 ms, but the plan path allows
 * 300 ms per signal. So every read races the source against a 300 ms budget and falls back to the
 * last good value; a slow source keeps refreshing in the background and the next read gets it.
 * Logs carry userId, source, ms, and cache age, never coordinates or calendar contents.
 */
import { createGrpcClient } from '@photon-ai/advanced-imessage/grpc';
import { OAuth2Client } from 'google-auth-library';
import { cloud } from 'spectrum-ts';
import { z } from 'zod';
import type { BusyInterval, GeoPoint } from '@bubbleworks/shared';
import type { Logger } from '../events/bus.js';
import type { GoogleOAuthConfig, GoogleTokenStore } from './google-oauth.js';

export const SIGNAL_BUDGET_MS = 300;

interface Entry<T> {
  value: T;
  at: number;
}

export interface CachedRead<T> {
  value: T | null;
  /** 'fresh' came from the source within budget; 'cache' is an earlier value; 'none' is nothing. */
  from: 'fresh' | 'cache' | 'none';
  ageMs: number | null;
  ms: number;
}

/**
 * Stale-while-revalidate cache with a hard read budget. One in-flight fetch per key: concurrent
 * readers share it, and a fetch that misses the budget still lands in the cache when it finishes.
 */
export class SignalCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T | null>>();

  constructor(
    private readonly name: string,
    private readonly ttlMs: number,
    private readonly options: { budgetMs?: number; now?: () => number; log?: Logger } = {},
  ) {}

  async read(key: string, fetch: () => Promise<T | null>): Promise<CachedRead<T>> {
    const now = this.options.now ?? Date.now;
    const t0 = now();
    const hit = this.entries.get(key);
    if (hit && t0 - hit.at < this.ttlMs) {
      return { value: hit.value, from: 'cache', ageMs: t0 - hit.at, ms: 0 };
    }

    const job = this.refresh(key, fetch);
    const budget = this.options.budgetMs ?? SIGNAL_BUDGET_MS;
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), budget).unref());
    const result = await Promise.race([job, timeout]);
    const ms = now() - t0;
    if (result !== 'timeout' && result !== null) {
      return { value: result, from: 'fresh', ageMs: 0, ms };
    }
    const stale = this.entries.get(key);
    const read: CachedRead<T> = stale
      ? { value: stale.value, from: 'cache', ageMs: now() - stale.at, ms }
      : { value: null, from: 'none', ageMs: null, ms };
    this.options.log?.debug(
      {
        signal: this.name,
        key,
        from: read.from,
        ms,
        ageMs: read.ageMs,
        timedOut: result === 'timeout',
      },
      'signal fallback',
    );
    return read;
  }

  /** Start a refresh without waiting, e.g. for every member when a plan starts. */
  prefetch(key: string, fetch: () => Promise<T | null>): void {
    void this.refresh(key, fetch);
  }

  peek(key: string): Entry<T> | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, at: (this.options.now ?? Date.now)() });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  private refresh(key: string, fetch: () => Promise<T | null>): Promise<T | null> {
    const running = this.inflight.get(key);
    if (running) return running;
    const now = this.options.now ?? Date.now;
    const t0 = now();
    const job = fetch()
      .then((value) => {
        if (value !== null) this.entries.set(key, { value, at: now() });
        this.options.log?.debug(
          { signal: this.name, key, ms: now() - t0, ok: value !== null },
          'signal fetched',
        );
        return value;
      })
      .catch((err: unknown) => {
        this.options.log?.warn(
          { signal: this.name, key, ms: now() - t0, err: (err as Error).message },
          'signal fetch failed',
        );
        return null;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface LocationFix extends GeoPoint {
  /** When the device captured the fix (ISO), when Photon reports it. */
  capturedAt: string | null;
}

export interface LocationSource {
  /** `address` is the person's registered phone. Null when they are not sharing. */
  get(address: string): Promise<LocationFix | null>;
}

/** Find My through Photon Pro's shared Advanced iMessage endpoint (read-only, no LINE LOCK). */
export class PhotonLocationSource implements LocationSource {
  private token: { value: string; expiresAt: number } | null = null;
  private client: ReturnType<typeof createGrpcClient> | null = null;

  constructor(
    private readonly projectId: string,
    private readonly projectSecret: string,
    private readonly address = 'imessage.spectrum.photon.codes:443',
  ) {}

  async get(phone: string): Promise<LocationFix | null> {
    const im = await this.im();
    try {
      const loc = await im.locations.get(phone);
      if (loc.latitude === undefined || loc.longitude === undefined) return null;
      return {
        lat: loc.latitude,
        lng: loc.longitude,
        capturedAt: loc.locationTimestamp ? new Date(loc.locationTimestamp).toISOString() : null,
      };
    } catch (err) {
      // Not sharing (NotFoundError) is a normal answer, not a failure.
      if ((err as Error).name === 'NotFoundError') return null;
      throw err;
    }
  }

  /** Shared token lasts ~900 s; reconnect a minute before it expires. */
  private async im(): Promise<ReturnType<typeof createGrpcClient>> {
    if (this.client && this.token && this.token.expiresAt - Date.now() > 60_000) return this.client;
    const data = await cloud.issueImessageTokens(this.projectId, this.projectSecret);
    if (data.type !== 'shared')
      throw new Error(`expected a shared iMessage token, got ${data.type}`);
    await this.client?.close().catch(() => undefined);
    this.token = { value: data.token, expiresAt: Date.now() + data.expiresIn * 1000 };
    this.client = createGrpcClient({
      address: this.address,
      token: data.token,
      tls: true,
      timeout: 15_000,
    });
    return this.client;
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = null;
  }
}

export interface FreeBusySource {
  /** Null when the person has not connected a calendar. */
  busy(userId: string, range: { start: string; end: string }): Promise<BusyInterval[] | null>;
}

const FreeBusyResponse = z.object({
  calendars: z.record(
    z.string(),
    z.object({ busy: z.array(z.object({ start: z.string(), end: z.string() })) }),
  ),
});

export class GoogleFreeBusySource implements FreeBusySource {
  constructor(
    private readonly config: GoogleOAuthConfig,
    private readonly tokens: GoogleTokenStore,
  ) {}

  async busy(
    userId: string,
    range: { start: string; end: string },
  ): Promise<BusyInterval[] | null> {
    const creds = this.tokens.get(userId);
    if (!creds?.refresh_token) return null;
    const client = new OAuth2Client({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      redirectUri: this.config.redirectUri,
    });
    client.setCredentials(creds);
    client.on('tokens', (t) => this.tokens.save(userId, t));
    const res = await client.request({
      url: 'https://www.googleapis.com/calendar/v3/freeBusy',
      method: 'POST',
      data: { timeMin: range.start, timeMax: range.end, items: [{ id: 'primary' }] },
      timeout: 5_000,
    });
    const busy = FreeBusyResponse.parse(res.data).calendars['primary']?.busy ?? [];
    return busy.map((b) => ({
      start: new Date(b.start).toISOString(),
      end: new Date(b.end).toISOString(),
    }));
  }
}

// ---------------------------------------------------------------------------
// Presence (Focus is not readable on Photon Pro)
// ---------------------------------------------------------------------------

export type PresenceCommand = 'focus' | 'sleep' | 'driving' | 'available';

/** "busy", "sleeping", "driving", "back" and friends. Null when the text is not a command. */
export function parsePresenceCommand(text: string): PresenceCommand | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '');
  if (/^(busy|focus|focusing|in a meeting|working|dnd|do not disturb|heads down)$/.test(t)) {
    return 'focus';
  }
  if (/^(sleeping|going to (bed|sleep)|bed|bedtime|goodnight|good night|gn|nap(ping)?)$/.test(t)) {
    return 'sleep';
  }
  if (/^(driving|on the road|in the car)$/.test(t)) return 'driving';
  if (/^(back|free|available|i'?m (back|free|around)|done)$/.test(t)) return 'available';
  return null;
}

/** How long a presence command lasts: sleep until 07:00 local, the others 3 hours. */
export function presenceUntil(
  command: Exclude<PresenceCommand, 'available'>,
  now: Date,
  timeZone = 'America/New_York',
): string {
  if (command !== 'sleep') return new Date(now.getTime() + 3 * 3_600_000).toISOString();
  const hour = localHour(now, timeZone);
  const hoursTo7 = hour < 7 ? 7 - hour : 24 - hour + 7;
  const until = new Date(now.getTime() + hoursTo7 * 3_600_000);
  until.setUTCMinutes(0, 0, 0);
  return until.toISOString();
}

export function localHour(d: Date, timeZone = 'America/New_York'): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(d),
  );
}

/** Quiet hours: nobody is pinged between 23:00 and 07:00 local. */
export function inQuietHours(d: Date, timeZone = 'America/New_York'): boolean {
  const h = localHour(d, timeZone);
  return h >= 23 || h < 7;
}
