import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../app.js';
import { loadConfig } from '../config.js';
import { PlanStore } from '../engine/plan-store.js';
import type { Runtime } from '../runtime.js';
import { INTENT, testRuntime } from '../test-helpers.js';
import { registerWatchRoute } from './watch-route.js';

const SECRET = 'test-secret-with-16-chars-or-more';

let app: App;
let rt: Runtime;
let store: PlanStore;
let nowMs: number;

async function start(
  secret: string | undefined,
  urls: { web?: string; server?: string } = { web: 'https://page.test/' },
): Promise<void> {
  app = await buildApp({
    config: loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }),
    replayForToken: (t) => rt.bus.replayForToken(t),
  });
  registerWatchRoute(app.fastify, {
    secret,
    plans: store,
    webPublicUrl: urls.web,
    serverPublicUrl: urls.server,
  });
  await app.fastify.ready();
}

/** A plan created one minute after the previous one. */
function plan(chatId: string) {
  nowMs += 60_000;
  return store.create({
    groupId: 'group_demo',
    chatId,
    intent: INTENT,
    createdByUserId: 'user_ava',
  });
}

beforeEach(() => {
  rt = testRuntime();
  nowMs = Date.parse('2026-10-10T22:00:00.000Z');
  store = new PlanStore(rt.db, rt.bus, { now: () => new Date(nowMs) });
});
afterEach(async () => {
  await app.fastify.close();
  rt.close();
});

describe('GET /watch/:secret', () => {
  it('is a 404 for a wrong secret, and for any secret when none is configured', async () => {
    await start(SECRET);
    expect((await app.fastify.inject({ url: '/watch/nope' })).statusCode).toBe(404);
    await app.fastify.close();
    await start(undefined);
    expect((await app.fastify.inject({ url: `/watch/${SECRET}` })).statusCode).toBe(404);
  });

  it('redirects to the website’s watch page, or serves the frame shell without WEB_PUBLIC_URL', async () => {
    await start(SECRET, { web: 'https://page.test/', server: 'https://api.test/' });
    const redirect = await app.fastify.inject({ url: `/watch/${SECRET}` });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe(
      `https://page.test/watch?s=${SECRET}&api=${encodeURIComponent('https://api.test')}`,
    );
    await app.fastify.close();
    await start(SECRET, { web: 'https://page.test' });
    const noApi = await app.fastify.inject({ url: `/watch/${SECRET}` });
    expect(noApi.headers.location).toBe(`https://page.test/watch?s=${SECRET}`);
    await app.fastify.close();
    await start(SECRET, {});
    const res = await app.fastify.inject({ url: `/watch/${SECRET}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain(`/watch/${SECRET}/latest`);
    expect(res.body).toContain('<iframe');
    const latest = await app.fastify.inject({ url: `/watch/${SECRET}/latest` });
    expect(latest.json()).toEqual({
      ok: true,
      planId: null,
      state: null,
      createdAt: null,
      pageUrl: null,
    });
  });

  it('latest points at the newest plan’s live page, and /go redirects there', async () => {
    await start(SECRET);
    plan('crew:a');
    const newest = plan('crew:b');
    const latest = await app.fastify.inject({ url: `/watch/${SECRET}/latest` });
    expect(latest.json().pageUrl).toBe(`https://page.test/p/${newest.pageToken}`);
    const go = await app.fastify.inject({ url: `/watch/${SECRET}/go` });
    expect(go.statusCode).toBe(302);
    expect(go.headers.location).toBe(`https://page.test/p/${newest.pageToken}`);
    expect((await app.fastify.inject({ url: '/watch/nope/latest' })).statusCode).toBe(404);
  });

  it('prefers an active plan over a newer closed one, and falls back to the newest closed', async () => {
    await start(SECRET);
    const active = plan('crew:a');
    const closed = plan('crew:b');
    await store.transition(closed.id, 'CANCELLED');
    const first = await app.fastify.inject({ url: `/watch/${SECRET}/latest` });
    expect(first.json().pageUrl).toBe(`https://page.test/p/${active.pageToken}`);
    await store.transition(active.id, 'CANCELLED');
    const second = await app.fastify.inject({ url: `/watch/${SECRET}/latest` });
    expect(second.json().pageUrl).toBe(`https://page.test/p/${closed.pageToken}`);
  });
});
