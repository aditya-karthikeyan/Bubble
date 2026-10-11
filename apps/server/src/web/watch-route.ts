/**
 * GET /watch/:secret: a stable, private page for the organizer's laptop. It frames the live
 * page of the newest plan (an active one first, else the most recently created) and follows
 * the next plan on its own; /watch/:secret/latest is what it polls; /watch/:secret/go redirects. The secret is
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

function watchPageHtml(secret: string): string {
  const latest = `/watch/${encodeURIComponent(secret)}/latest`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Bubbleworks · live</title>
<style>html,body{margin:0;height:100%;background:#0b1526;color:#e9f0fb;font:15px system-ui,sans-serif}
iframe{border:0;width:100%;height:100%;display:block}
#msg{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:2rem}
#msg.hidden{display:none}</style></head><body>
<div id="msg">Waiting for a plan. Start one from a bubble; this page follows it.</div>
<iframe id="live" title="Live plan" allow="autoplay"></iframe>
<script>
(function () {
  var current = null, frame = document.getElementById('live'), msg = document.getElementById('msg');
  function tick() {
    fetch(${JSON.stringify(latest)}, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.pageUrl && j.pageUrl !== current) {
          current = j.pageUrl; frame.src = current; msg.classList.add('hidden');
        } else if (j && !j.pageUrl && !current) { msg.classList.remove('hidden'); }
      })
      .catch(function () {});
  }
  tick(); setInterval(tick, 3000);
})();
</script></body></html>`;
}

export function registerWatchRoute(app: FastifyInstance, options: WatchRouteOptions): void {
  const guard = (given: string): boolean => {
    const { secret } = options;
    return !!secret && sameSecret(given, secret);
  };
  const pageUrlFor = (plan: Plan | null): string | null => {
    const base = options.webPublicUrl?.replace(/\/$/, '');
    return plan && base ? `${base}/p/${plan.pageToken}` : null;
  };

  /** The organizer's page: a frame that follows the newest plan without a refresh. */
  app.get<{ Params: { secret: string } }>('/watch/:secret', async (request, reply) => {
    if (!guard(request.params.secret)) {
      return reply.code(404).send({ ok: false, error: 'not found' });
    }
    reply.header('cache-control', 'no-store');
    if (!options.webPublicUrl) {
      return reply.code(503).send({ ok: false, error: 'WEB_PUBLIC_URL is not set' });
    }
    return reply.type('text/html; charset=utf-8').send(watchPageHtml(request.params.secret));
  });

  /** Polled by the page every few seconds: where the newest plan's live view is. */
  app.get<{ Params: { secret: string } }>('/watch/:secret/latest', async (request, reply) => {
    if (!guard(request.params.secret)) {
      return reply.code(404).send({ ok: false, error: 'not found' });
    }
    reply.header('cache-control', 'no-store');
    const plan = watchedPlan(options.plans);
    return {
      ok: true,
      planId: plan?.id ?? null,
      state: plan?.state ?? null,
      pageUrl: pageUrlFor(plan),
    };
  });

  /** The old one-shot redirect, for anyone who bookmarked it with ?go. */
  app.get<{ Params: { secret: string } }>('/watch/:secret/go', async (request, reply) => {
    if (!guard(request.params.secret)) {
      return reply.code(404).send({ ok: false, error: 'not found' });
    }
    reply.header('cache-control', 'no-store');
    const plan = watchedPlan(options.plans);
    if (!plan) return reply.type('text/html; charset=utf-8').send(NO_PLAN_HTML);
    const url = pageUrlFor(plan);
    if (!url) return reply.code(503).send({ ok: false, error: 'WEB_PUBLIC_URL is not set' });
    return reply.redirect(url, 302);
  });
}
