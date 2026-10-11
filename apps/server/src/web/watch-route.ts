/**
 * GET /watch/:secret: a stable, private link for the organizer's laptop. Redirects to the live
 * page of the newest plan (an active one first, else the most recently created). The secret is
 * DEV_ROUTES_SECRET; without it the route is a 404, so members never get a working link.
 */
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { Plan } from '@bubbleworks/shared';
import type { PlanStore } from '../engine/plan-store.js';

export interface WatchRouteOptions {
  /** DEV_ROUTES_SECRET. Unset means every request is a 404. */
  secret: string | undefined;
  plans: Pick<PlanStore, 'findAllActive' | 'newest'>;
  /** WEB_PUBLIC_URL, where the live page lives (/p/<token>). */
  webPublicUrl: string | undefined;
}

const NO_PLAN_HTML =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>Bubbleworks</title></head>' +
  '<body style="font-family: system-ui, sans-serif; padding: 2rem">' +
  '<p>No plan yet. Start one from a bubble and refresh.</p></body></html>';

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Newest active plan, else the newest plan of any state. */
export function watchedPlan(plans: WatchRouteOptions['plans']): Plan | null {
  const active = plans.findAllActive().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return active[0] ?? plans.newest();
}

export function registerWatchRoute(app: FastifyInstance, options: WatchRouteOptions): void {
  app.get<{ Params: { secret: string } }>('/watch/:secret', async (request, reply) => {
    const { secret } = options;
    if (!secret || !sameSecret(request.params.secret, secret)) {
      return reply.code(404).send({ ok: false, error: 'not found' });
    }
    reply.header('cache-control', 'no-store');
    const plan = watchedPlan(options.plans);
    if (!plan) return reply.type('text/html; charset=utf-8').send(NO_PLAN_HTML);
    const base = options.webPublicUrl?.replace(/\/$/, '');
    if (!base) {
      return reply.code(503).send({ ok: false, error: 'WEB_PUBLIC_URL is not set' });
    }
    return reply.redirect(`${base}/p/${plan.pageToken}`, 302);
  });
}
