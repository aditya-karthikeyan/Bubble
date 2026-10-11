/**
 * Dev-only HTTP routes, registered only when DEV_ROUTES_SECRET is set. Every request must carry
 * the same value in the x-dev-secret header. Used by P4 to drive the live page and by
 * rehearsals to stage a plan without the messaging line.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { audit } from '../db/schema.js';
import { timingSafeEqual } from 'node:crypto';
import type { Runtime } from '../runtime.js';
import { createDemoPlan, HAPPY_PATH, stepDemoPlan } from './demo-plan.js';
import { demoReset } from './demo-reset.js';
import { registerDevUserRoutes } from './users-route.js';

export interface DevRouteOptions {
  secret: string;
  runtime: Runtime;
  webPublicUrl?: string;
}

function sameSecret(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerDevRoutes(app: FastifyInstance, options: DevRouteOptions): void {
  const { runtime } = options;
  const pageUrl = (token: string) =>
    options.webPublicUrl ? `${options.webPublicUrl.replace(/\/$/, '')}/p/${token}` : null;

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/dev/')) return;
    if (!sameSecret(request.headers['x-dev-secret'], options.secret)) {
      await reply.code(401).send({ ok: false, error: 'bad or missing x-dev-secret' });
    }
  });

  app.post('/api/dev/plans', async () => {
    const { plan, candidates, eventsPublished } = await createDemoPlan(runtime);
    return {
      ok: true,
      planId: plan.id,
      state: plan.state,
      token: plan.pageToken,
      pageUrl: pageUrl(plan.pageToken),
      candidates: candidates.map((v) => v.name),
      eventsPublished,
      next: HAPPY_PATH[0],
    };
  });

  app.post<{ Params: { planId: string } }>(
    '/api/dev/plans/:planId/step',
    async (request, reply) => {
      try {
        const { plan, eventsPublished } = await stepDemoPlan(runtime, request.params.planId);
        const idx = HAPPY_PATH.indexOf(plan.state);
        return {
          ok: true,
          planId: plan.id,
          state: plan.state,
          eventsPublished,
          next: HAPPY_PATH[idx + 1] ?? null,
        };
      } catch (err) {
        return reply.code(409).send({ ok: false, error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { planId: string } }>('/api/dev/plans/:planId', async (request, reply) => {
    const plan = runtime.plans.get(request.params.planId);
    if (!plan) return reply.code(404).send({ ok: false, error: 'no such plan' });
    const events = await runtime.bus.replay(plan.id);
    // Server-internal audit rows (solver runs, deadlock analysis, transitions) for rehearsal debugging.
    const auditRows = runtime.db.select().from(audit).where(eq(audit.planId, plan.id)).all();
    return {
      ok: true,
      plan: {
        id: plan.id,
        state: plan.state,
        token: plan.pageToken,
        pageUrl: pageUrl(plan.pageToken),
      },
      members: runtime.plans.members(plan.id),
      events,
      audit: auditRows,
    };
  });

  /** Rehearsal reset: plans and plan state go, people, facts, crews, venues stay. */
  app.post('/api/dev/reset', async () => {
    const result = demoReset(runtime.db);
    runtime.candidates.invalidate();
    return { ok: true, ...result };
  });

  app.get('/api/dev/plans', async () => ({
    ok: true,
    active: runtime.plans
      .findAllActive()
      .map((p) => ({ id: p.id, state: p.state, token: p.pageToken })),
    pendingTimers: runtime.timers.pending().length,
  }));

  registerDevUserRoutes(app, runtime);
}
