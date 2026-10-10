import { sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Runtime } from '../runtime.js';
import { testRuntime } from '../test-helpers.js';
import { FactStore } from './facts.js';
import {
  calendarConnectUrl,
  GoogleTokenStore,
  registerGoogleOAuthRoutes,
  signState,
  verifyState,
  type GoogleOAuthConfig,
} from './google-oauth.js';

const CFG: GoogleOAuthConfig = {
  clientId: 'client.apps.googleusercontent.com',
  clientSecret: 'test-secret',
  redirectUri: 'http://localhost:3001/oauth/google/callback',
  publicBaseUrl: 'http://localhost:3001',
};

describe('google calendar connect', () => {
  let rt: Runtime;
  beforeEach(() => {
    rt = testRuntime();
  });
  afterEach(() => rt.close());

  it('signs state so a link cannot be pointed at someone else', () => {
    const state = signState('user_ava', 'k');
    expect(verifyState(state, 'k')).toBe('user_ava');
    expect(verifyState(state, 'other-key')).toBeNull();
    const forged = `${Buffer.from('user_ben').toString('base64url')}.${state.split('.')[1]}`;
    expect(verifyState(forged, 'k')).toBeNull();
    expect(verifyState('garbage', 'k')).toBeNull();
  });

  it('short link redirects to Google, and the callback stores tokens', async () => {
    const app = Fastify();
    const tokens = new GoogleTokenStore(rt.db);
    const connected: string[] = [];
    registerGoogleOAuthRoutes(app, {
      config: CFG,
      tokens,
      onConnected: async (id) => void connected.push(id),
      exchangeCode: async (code) => ({
        refresh_token: `r-${code}`,
        access_token: 'a',
        expiry_date: 1,
        scope: 'https://www.googleapis.com/auth/calendar.freebusy',
      }),
    });

    const link = calendarConnectUrl(CFG, 'user_ava');
    expect(link.length).toBeLessThan(120);
    const start = await app.inject({ method: 'GET', url: link.replace(CFG.publicBaseUrl, '') });
    expect(start.statusCode).toBe(302);
    const google = new URL(start.headers['location'] as string);
    expect(google.hostname).toBe('accounts.google.com');
    expect(google.searchParams.get('response_type')).toBe('code');
    expect(google.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/calendar.freebusy',
    );
    const state = google.searchParams.get('state')!;

    const cb = await app.inject({
      method: 'GET',
      url: `/oauth/google/callback?code=abc&state=${state}`,
    });
    expect(cb.statusCode).toBe(200);
    expect(cb.body).toContain('Calendar connected');
    expect(tokens.get('user_ava')?.refresh_token).toBe('r-abc');
    expect(connected).toEqual(['user_ava']);

    const bad = await app.inject({ method: 'GET', url: '/oauth/google/start?u=nope' });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});

describe('FactStore merge rules', () => {
  let rt: Runtime;
  let store: FactStore;
  let clock = new Date('2026-10-10T20:00:00.000Z');
  beforeEach(() => {
    rt = testRuntime();
    store = new FactStore(rt.db, () => clock);
  });
  afterEach(() => rt.close());

  const base = {
    userId: 'user_ava',
    hard: false,
    confidence: 0.8,
    source: 'chat' as const,
    confirmed: false,
    expiresAt: null,
  };
  const tick = () => (clock = new Date(clock.getTime() + 1000));

  it('replaces single-valued facts, keeping a permanent budget under a temporary one', () => {
    tick();
    store.record({ ...base, type: 'budget_max', value: '40', hard: true });
    tick();
    store.record({ ...base, type: 'budget_max', value: '35', hard: true });
    tick();
    store.record({
      ...base,
      type: 'budget_max',
      value: '15',
      hard: true,
      expiresAt: '2026-10-17T03:59:59.000Z',
    });
    const budgets = store.active('user_ava').filter((f) => f.type === 'budget_max');
    expect(budgets.map((f) => f.value)).toEqual(['15', '35']);
    expect(store.current('user_ava', 'budget_max')?.value).toBe('15');
  });

  it('picks the temporary value deterministically even when written in the same millisecond', () => {
    for (let i = 0; i < 25; i++) {
      const userId = `user_tie_${i}`;
      rt.db.run(
        sql`insert into users (id, display_name, handle, timezone, created_at) values (${userId}, 'T', ${`+1919555${String(1000 + i)}`}, 'America/New_York', '2026-10-10T00:00:00Z')`,
      );
      store.record({ ...base, userId, type: 'budget_max', value: '30', hard: true });
      store.record({
        ...base,
        userId,
        type: 'budget_max',
        value: '15',
        hard: true,
        expiresAt: '2026-10-17T03:59:59.000Z',
      });
      expect(store.current(userId, 'budget_max')?.value).toBe('15');
      expect(store.deleteLatest(userId)?.value).toBe('15');
    }
  });

  it('dedupes multi-valued facts and lets like/avoid cancel', () => {
    tick();
    store.record({ ...base, type: 'cuisine_like', value: 'thai', confidence: 0.6 });
    tick();
    store.record({ ...base, type: 'cuisine_like', value: 'thai', confidence: 0.9 });
    expect(store.active('user_ava').filter((f) => f.value === 'thai')).toHaveLength(1);
    tick();
    store.record({ ...base, type: 'cuisine_avoid', value: 'thai' });
    const thai = store.active('user_ava').filter((f) => f.value === 'thai');
    expect(thai.map((f) => f.type)).toEqual(['cuisine_avoid']);
  });

  it('never downgrades a confirmed allergy on a repeat mention', () => {
    tick();
    const a = store.record({
      ...base,
      type: 'allergy',
      value: 'peanut',
      hard: true,
      confirmed: true,
      source: 'onboarding',
    });
    tick();
    store.record({ ...base, type: 'allergy', value: 'peanut', hard: true, confirmed: false });
    expect(store.get(a.id)?.confirmed).toBe(true);
  });
});
