/**
 * POST /webhooks/elevenlabs: ElevenLabs post-call webhook. Verifies the HMAC signature against
 * the raw body, validates with zod, and hands the event to the caller. Unknown conversations and
 * event types get 200 so ElevenLabs does not retry them forever; bad signatures get 401.
 */
import type { FastifyInstance } from 'fastify';
import type { ElevenLabsCaller } from './adapter.js';
import { WebhookEvent } from './conversation.js';
import { verifySignature } from './signature.js';

export const WEBHOOK_PATH = '/webhooks/elevenlabs';

export interface CallerWebhookOptions {
  secret: string;
  caller: Pick<ElevenLabsCaller, 'handleWebhook'>;
}

export async function registerCallerWebhook(
  app: FastifyInstance,
  options: CallerWebhookOptions,
): Promise<void> {
  // Encapsulated so the raw-string JSON parser applies to this route only.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: 10 * 1024 * 1024 },
      (_req, body, done) => done(null, body),
    );
    scope.post(WEBHOOK_PATH, async (request, reply) => {
      const raw = typeof request.body === 'string' ? request.body : '';
      const sig = request.headers['elevenlabs-signature'];
      const check = verifySignature(raw, Array.isArray(sig) ? sig[0] : sig, options.secret);
      if (!check.ok) {
        request.log.warn({ reason: check.reason }, 'elevenlabs webhook rejected');
        return reply.code(401).send({ ok: false, error: check.reason });
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return reply.code(400).send({ ok: false, error: 'invalid json' });
      }
      const type = (json as { type?: unknown } | null)?.type;
      const parsed = WebhookEvent.safeParse(json);
      if (!parsed.success) {
        request.log.info({ type }, 'elevenlabs webhook ignored');
        return { ok: true, result: 'ignored' };
      }
      const result = await options.caller.handleWebhook(parsed.data);
      request.log.info({ type, result }, 'elevenlabs webhook handled');
      return { ok: true, result };
    });
  });
}
