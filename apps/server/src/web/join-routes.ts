/**
 * Signup and crew-join routes: the server-hosted join page, the crew name lookup, signup, and
 * the phone-only join for people who already have a bubble.
 *
 * The bubble texts first: after a signup or a join the server has the bubble send the welcome
 * (onboarding question 1, or "You're in <crew>") and tells the crew's creator who joined. Those
 * messages go out in the background so the page never waits on iMessage.
 */
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CrewDirectory } from '@bubbleworks/shared';
import type { DbBubbleService } from '../bubbles/service.js';
import type { SignupResult } from '../messaging/signup.js';
import { joinPageHtml } from './join-page.js';

export interface JoinRoutesDeps {
  crews: Pick<CrewDirectory, 'crewByJoinCode' | 'userByHandle'>;
  signup: (raw: unknown) => Promise<SignupResult>;
  bubbles: Pick<DbBubbleService, 'addToCrew' | 'welcome'>;
}

const JoinInput = z.object({
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'E.164, e.g. +15551234567'),
});

export function registerJoinRoutes(app: FastifyInstance, deps: JoinRoutesDeps): void {
  /** Messages go out after the response; a failure is logged, never surfaced to the page. */
  const inBackground = (log: FastifyBaseLogger, userId: string, work: Promise<void>): void => {
    work.catch((err: unknown) =>
      log.error({ userId, err: String(err) }, 'bubble welcome after signup/join failed'),
    );
  };

  /** The crew link people tap. Served here so it works even when the web app lags behind. */
  app.get<{ Params: { code: string } }>('/join/:code', async (request, reply) => {
    const crew = await deps.crews.crewByJoinCode(request.params.code);
    return reply
      .type('text/html; charset=utf-8')
      .send(joinPageHtml({ code: request.params.code, crewName: crew?.name ?? null }));
  });

  /** The join page shows the crew's name before signup. Only the name leaves the server. */
  app.get<{ Params: { code: string } }>('/api/crews/:code', async (request, reply) => {
    const crew = await deps.crews.crewByJoinCode(request.params.code);
    if (!crew) return reply.code(404).send({ ok: false, error: 'no such crew' });
    return { ok: true, name: crew.name };
  });

  app.post('/api/signup', async (request, reply) => {
    let result: SignupResult;
    try {
      result = await deps.signup(request.body);
    } catch (err) {
      request.log.warn({ err: String(err) }, 'signup rejected');
      return reply.code(400).send({ ok: false, error: 'invalid signup' });
    }
    // The bubble reaches out first: welcome + question 1, once per person.
    inBackground(
      request.log,
      result.user.id,
      deps.bubbles.welcome(result.user.id, {
        crewId: result.crewId,
        newMember: result.newMember,
      }),
    );
    return {
      ok: true,
      bubbleNumber: result.bubbleNumber,
      smsLink: result.smsLink,
      crewName: result.crewName,
    };
  });

  /**
   * "Already have a bubble? Just your number": a known phone goes straight into the crew. An
   * unknown phone gets known: false and the page shows the full signup form instead.
   */
  app.post<{ Params: { code: string } }>('/api/crews/:code/join', async (request, reply) => {
    const input = JoinInput.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ ok: false, error: 'invalid phone' });
    const crew = await deps.crews.crewByJoinCode(request.params.code);
    if (!crew) return reply.code(404).send({ ok: false, error: 'no such crew' });
    const user = await deps.crews.userByHandle(input.data.phone);
    if (!user) return { ok: true, known: false };
    const joined = await deps.bubbles.addToCrew(user.id, crew);
    inBackground(
      request.log,
      user.id,
      deps.bubbles.welcome(user.id, { crewId: crew.id, newMember: joined.newMember }),
    );
    request.log.info({ groupId: crew.id, userId: user.id }, 'joined crew from the join page');
    return { ok: true, known: true, crewName: joined.crew.name };
  });
}
