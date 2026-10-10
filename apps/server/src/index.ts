import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createRuntime } from './runtime.js';

async function main(): Promise<void> {
  const config = loadConfig();
  // Build the app first so its logger serves the runtime too.
  const pending = { runtime: null as ReturnType<typeof createRuntime> | null };
  const app = await buildApp({
    config,
    replayForToken: (token) =>
      pending.runtime ? pending.runtime.bus.replayForToken(token) : Promise.resolve(null),
    health: () =>
      pending.runtime
        ? {
            activePlans: pending.runtime.plans.findAllActive().length,
            pendingTimers: pending.runtime.timers.pending().length,
            venues: pending.runtime.seed?.venues ?? null,
          }
        : {},
  });
  const runtime = createRuntime(config, { log: app.fastify.log });
  pending.runtime = runtime;
  runtime.bus.setBroadcaster((token, event) => app.live.broadcast(token, event));
  runtime.timers.start();

  const active = runtime.plans.findAllActive();
  if (active.length) {
    app.fastify.log.info(
      { plans: active.map((p) => ({ id: p.id, state: p.state })) },
      'resuming plans in flight',
    );
  }

  const shutdown = async (signal: string) => {
    app.fastify.log.info({ signal }, 'shutting down');
    runtime.close();
    await app.fastify.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.fastify.listen({ port: config.PORT, host: config.HOST });
  app.fastify.log.info(
    {
      port: config.PORT,
      demoMode: config.DEMO_MODE,
      publicUrl: config.SERVER_PUBLIC_URL ?? null,
      db: config.DATABASE_PATH,
      venues: runtime.seed?.venues ?? null,
    },
    'bubbleworks server up',
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
