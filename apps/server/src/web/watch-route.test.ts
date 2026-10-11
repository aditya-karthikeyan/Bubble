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

async function start(secret: string | undefined): Promise<void> {
  app = await buildApp({
    config: loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }),
    replayForToken: (t) => rt.bus.replayForToken(t),
  });
  registerWatchRoute(app.fastify, {
    secret,
    plans: store,
    webPublicUrl: 'https://page.test/',
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

  it('serves a small page when there is no plan yet', async () => {
    await start(SECRET);
    const res = await app.fastify.inject({ url: `/watch/${SECRET}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('No plan yet. Start one from a bubble and refresh.');
  });

  it('redirects to the newest plan’s live page', async () => {
    await start(SECRET);
    plan('crew:a');
    const newest = plan('crew:b');
    const res = await app.fastify.inject({ url: `/watch/${SECRET}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`https://page.test/p/${newest.pageToken}`);
  });

  it('prefers an active plan over a newer closed one, and falls back to the newest closed', async () => {
    await start(SECRET);
    const active = plan('crew:a');
    const closed = plan('crew:b');
    await store.transition(closed.id, 'CANCELLED');
    const first = await app.fastify.inject({ url: `/watch/${SECRET}` });
    expect(first.headers.location).toBe(`https://page.test/p/${active.pageToken}`);
    await store.transition(active.id, 'CANCELLED');
    const second = await app.fastify.inject({ url: `/watch/${SECRET}` });
    expect(second.headers.location).toBe(`https://page.test/p/${closed.pageToken}`);
  });
});
