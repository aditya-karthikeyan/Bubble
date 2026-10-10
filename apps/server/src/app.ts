import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PlanEvent } from '@bubbleworks/shared';
import type { Config } from './config.js';
import { attachLiveBridge, type LiveBridge } from './live/socket.js';

export interface AppDeps {
  config: Config;
  /** Phase 1 wires this to the EventBus. Until then, every token replays nothing. */
  replayForToken?: (token: string) => Promise<PlanEvent[] | null>;
}

export interface App {
  fastify: FastifyInstance;
  live: LiveBridge;
  startedAt: string;
}

export const SERVICE_NAME = 'bubbleworks-server';

export async function buildApp(deps: AppDeps): Promise<App> {
  const { config } = deps;
  const startedAt = new Date().toISOString();

  const fastify = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
    },
  });

  await fastify.register(cors, { origin: true });

  fastify.get('/health', async () => ({
    ok: true,
    service: SERVICE_NAME,
    env: config.NODE_ENV,
    demoMode: config.DEMO_MODE,
    startedAt,
    now: new Date().toISOString(),
  }));

  const live = attachLiveBridge(fastify.server, {
    replayForToken: deps.replayForToken ?? (async () => []),
    corsOrigin: true,
    log: fastify.log,
  });

  fastify.addHook('onClose', async () => {
    await live.close();
  });

  return { fastify, live, startedAt };
}
