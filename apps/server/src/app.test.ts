import { SOCKET } from '@bubbleworks/shared';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from './app.js';
import { loadConfig } from './config.js';

let app: App;
let baseUrl: string;

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', PORT: '0', LOG_LEVEL: 'error' });
  app = await buildApp({
    config,
    replayForToken: async (token) => (token === 'known-token-1234' ? [] : null),
  });
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  const address = app.fastify.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.fastify.close();
});

describe('server', () => {
  it('GET /health reports ok', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, service: 'bubbleworks-server', demoMode: false });
  });

  it('socket join with a known token acks ok and receives broadcasts', async () => {
    const socket = connect(`${baseUrl}${SOCKET.namespace}`, { transports: ['websocket'] });
    try {
      const ack = await new Promise<{ ok: boolean; replay: unknown[] }>((resolve) => {
        socket.emit(SOCKET.join, { token: 'known-token-1234' }, resolve);
      });
      expect(ack).toEqual({ ok: true, replay: [] });

      const received = new Promise<unknown>((resolve) => socket.once(SOCKET.plan_event, resolve));
      app.live.broadcast('known-token-1234', {
        type: 'plan_state_changed',
        planId: 'plan_test',
        at: new Date().toISOString(),
        from: 'IDLE',
        to: 'DETECTED',
      });
      expect(await received).toMatchObject({ type: 'plan_state_changed', to: 'DETECTED' });
    } finally {
      socket.disconnect();
    }
  });

  it('socket join with an unknown token is refused', async () => {
    const socket = connect(`${baseUrl}${SOCKET.namespace}`, { transports: ['websocket'] });
    try {
      const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        socket.emit(SOCKET.join, { token: 'nope-nope-nope' }, resolve);
      });
      expect(ack.ok).toBe(false);
    } finally {
      socket.disconnect();
    }
  });
});
