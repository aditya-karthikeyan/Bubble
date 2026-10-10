import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../app.js';
import { loadConfig } from '../config.js';
import type { Runtime } from '../runtime.js';
import { testRuntime } from '../test-helpers.js';
import { registerDevRoutes } from './routes.js';

let app: App;
let rt: Runtime;
const SECRET = 'test-secret-with-16-chars-or-more';

beforeAll(async () => {
  rt = testRuntime();
  app = await buildApp({
    config: loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }),
    replayForToken: (t) => rt.bus.replayForToken(t),
  });
  registerDevRoutes(app.fastify, {
    secret: SECRET,
    runtime: rt,
    webPublicUrl: 'https://page.test/',
  });
  await app.fastify.ready();
});
afterAll(async () => {
  await app.fastify.close();
  rt.close();
});

describe('dev routes', () => {
  it('refuses requests without the secret', async () => {
    const res = await app.fastify.inject({ method: 'POST', url: '/api/dev/plans' });
    expect(res.statusCode).toBe(401);
    const wrong = await app.fastify.inject({
      method: 'POST',
      url: '/api/dev/plans',
      headers: { 'x-dev-secret': 'nope' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('creates a demo plan with a page token and steps it to CLOSED', async () => {
    const h = { 'x-dev-secret': SECRET };
    const created = await app.fastify.inject({ method: 'POST', url: '/api/dev/plans', headers: h });
    expect(created.statusCode).toBe(200);
    const body = created.json() as {
      planId: string;
      token: string;
      pageUrl: string;
      state: string;
      candidates: string[];
    };
    expect(body.state).toBe('GATHERING');
    expect(body.pageUrl).toBe(`https://page.test/p/${body.token}`);
    expect(body.candidates).toContain('The Demo Table');
    expect((await rt.bus.replayForToken(body.token))?.length).toBeGreaterThanOrEqual(8);

    const states: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const step = await app.fastify.inject({
        method: 'POST',
        url: `/api/dev/plans/${body.planId}/step`,
        headers: h,
      });
      expect(step.statusCode).toBe(200);
      states.push((step.json() as { state: string }).state);
    }
    expect(states).toEqual(['DELIBERATING', 'LOCKED', 'BOOKING', 'BOOKED', 'DAY_OF', 'CLOSED']);
    const again = await app.fastify.inject({
      method: 'POST',
      url: `/api/dev/plans/${body.planId}/step`,
      headers: h,
    });
    expect(again.statusCode).toBe(409);

    const detail = await app.fastify.inject({
      method: 'GET',
      url: `/api/dev/plans/${body.planId}`,
      headers: h,
    });
    const d = detail.json() as { events: Array<{ type: string }> };
    const types = new Set(d.events.map((e) => e.type));
    for (const t of [
      'round_complete',
      'candidate_eliminated',
      'bubble_merged',
      'plan_locked',
      'booking_confirmed',
      'plan_closed',
    ]) {
      expect(types.has(t), t).toBe(true);
    }
  });
});
