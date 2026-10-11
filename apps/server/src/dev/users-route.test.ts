import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../app.js';
import { loadConfig } from '../config.js';
import { bubbleState, facts } from '../db/schema.js';
import type { Runtime } from '../runtime.js';
import { testRuntime } from '../test-helpers.js';
import { registerDevRoutes } from './routes.js';

let app: App;
let rt: Runtime;
let userId: string;
let crewId: string;
const SECRET = 'test-secret-with-16-chars-or-more';
const h = { 'x-dev-secret': SECRET };

beforeAll(async () => {
  rt = testRuntime();
  app = await buildApp({
    config: loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }),
    replayForToken: (t) => rt.bus.replayForToken(t),
  });
  registerDevRoutes(app.fastify, { secret: SECRET, runtime: rt });
  await app.fastify.ready();

  const user = await rt.crews.createUser({
    displayName: 'Rehearsal Rae',
    handle: '+15550001111',
    bubbleNumber: '+15550009999',
  });
  userId = user.id;
  const friend = await rt.crews.createUser({ displayName: 'Friend Fin', handle: '+15550002222' });
  crewId = (
    await rt.crews.createCrew({
      name: 'Rehearsers',
      createdByUserId: userId,
      memberIds: [friend.id],
    })
  ).id;
  rt.db
    .insert(facts)
    .values({
      id: 'fact_rae_peanut',
      userId,
      type: 'allergy',
      value: 'peanut',
      hard: true,
      confidence: 1,
      source: 'onboarding',
      confirmed: true,
      expiresAt: null,
      createdAt: '2026-10-10T12:00:00.000Z',
    })
    .run();
  rt.db
    .insert(bubbleState)
    .values({
      userId,
      onboardingStep: 'diet',
      presence: 'focus',
      presenceUntil: '2026-10-10T20:00:00.000Z',
      pinLat: 40.7,
      pinLng: -74,
      pinAt: '2026-10-10T12:05:00.000Z',
      updatedAt: '2026-10-10T12:05:00.000Z',
    })
    .run();
});
afterAll(async () => {
  await app.fastify.close();
  rt.close();
});

describe('dev users routes', () => {
  it('refuses requests without the secret', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/api/dev/users' });
    expect(res.statusCode).toBe(401);
  });

  it('lists every user with crews and facts', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/api/dev/users', headers: h });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; users: Array<Record<string, unknown>> };
    expect(body.ok).toBe(true);
    const rae = body.users.find((u) => u['id'] === userId);
    expect(rae).toMatchObject({
      displayName: 'Rehearsal Rae',
      handle: '+15550001111',
      bubbleNumber: '+15550009999',
      onboardedAt: null,
      crews: [
        {
          id: crewId,
          name: 'Rehearsers',
          status: expect.any(String),
          joinCode: expect.any(String),
          members: expect.arrayContaining([{ id: userId, displayName: 'Rehearsal Rae' }]),
        },
      ],
      facts: [
        {
          id: 'fact_rae_peanut',
          type: 'allergy',
          value: 'peanut',
          hard: true,
          confirmed: true,
          source: 'onboarding',
          expiresAt: null,
        },
      ],
    });
  });

  it('shows one user with their bubble state, and 404s an unknown id', async () => {
    const res = await app.fastify.inject({
      method: 'GET',
      url: `/api/dev/users/${userId}`,
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: Record<string, unknown> };
    expect(body.user['id']).toBe(userId);
    expect(body.user['facts']).toHaveLength(1);
    expect(body.user['bubble']).toMatchObject({
      onboardingStep: 'diet',
      presence: 'focus',
      presenceUntil: '2026-10-10T20:00:00.000Z',
      pin: { lat: 40.7, lng: -74, at: '2026-10-10T12:05:00.000Z' },
    });

    const missing = await app.fastify.inject({
      method: 'GET',
      url: '/api/dev/users/user_nope',
      headers: h,
    });
    expect(missing.statusCode).toBe(404);
  });
});
