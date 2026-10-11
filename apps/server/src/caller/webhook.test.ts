import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { WebhookEvent } from './conversation.js';
import { signPayload } from './signature.js';
import { WEBHOOK_PATH, registerCallerWebhook } from './webhook.js';

const SECRET = 'wsec_test';

async function app() {
  const seen: WebhookEvent[] = [];
  const fastify = Fastify();
  await registerCallerWebhook(fastify, {
    secret: SECRET,
    caller: {
      handleWebhook: async (event) => {
        seen.push(event);
        return 'processed';
      },
    },
  });
  // A sibling route keeps normal JSON parsing.
  fastify.post('/other', async (request) => ({ body: request.body }));
  return { fastify, seen };
}

function post(body: string, signature: string | undefined) {
  return {
    method: 'POST' as const,
    url: WEBHOOK_PATH,
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'elevenlabs-signature': signature } : {}),
    },
    payload: body,
  };
}

const now = () => Math.floor(Date.now() / 1000);
const BODY = JSON.stringify({
  type: 'post_call_transcription',
  event_timestamp: 1,
  data: { conversation_id: 'conv_1', status: 'done', analysis: { data_collection_results: {} } },
});

describe('POST /webhooks/elevenlabs', () => {
  it('verifies the raw body and hands the parsed event to the caller', async () => {
    const { fastify, seen } = await app();
    const res = await fastify.inject(post(BODY, signPayload(BODY, SECRET, now())));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, result: 'processed' });
    expect(seen[0]).toMatchObject({
      type: 'post_call_transcription',
      data: { conversation_id: 'conv_1' },
    });
  });

  it('rejects a bad or missing signature with 401', async () => {
    const { fastify, seen } = await app();
    expect((await fastify.inject(post(BODY, undefined))).statusCode).toBe(401);
    expect((await fastify.inject(post(BODY, signPayload(BODY, 'wrong', now())))).statusCode).toBe(
      401,
    );
    const tampered = BODY.replace('conv_1', 'conv_2');
    expect(
      (await fastify.inject(post(tampered, signPayload(BODY, SECRET, now())))).statusCode,
    ).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('acknowledges event types it does not handle', async () => {
    const { fastify, seen } = await app();
    const body = JSON.stringify({ type: 'something_new', data: {} });
    const res = await fastify.inject(post(body, signPayload(body, SECRET, now())));
    expect(res.json()).toEqual({ ok: true, result: 'ignored' });
    expect(seen).toHaveLength(0);
  });

  it('leaves JSON parsing alone on other routes', async () => {
    const { fastify } = await app();
    const res = await fastify.inject({ method: 'POST', url: '/other', payload: { a: 1 } });
    expect(res.json()).toEqual({ body: { a: 1 } });
  });
});
