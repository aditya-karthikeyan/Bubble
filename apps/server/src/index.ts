import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { registerDevRoutes } from './dev/routes.js';
import { createMessaging, loadMessagingConfig } from './messaging/index.js';
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

  // P2 messaging adapter. The terminal provider is Spectrum's local TUI, so it only starts
  // when there is a terminal to draw on; the real line starts only when SPECTRUM_PROVIDER=imessage
  // is set on the process holding the LINE LOCK. Signup works either way.
  const messagingConfig = loadMessagingConfig();
  const messaging = createMessaging({ config: messagingConfig, runtime });
  const startMessaging = messagingConfig.SPECTRUM_PROVIDER === 'imessage' || process.stdin.isTTY;
  if (startMessaging) await messaging.start();
  else app.fastify.log.info('messaging transport not started: terminal provider without a TTY');

  if (config.DEV_ROUTES_SECRET) {
    registerDevRoutes(app.fastify, {
      secret: config.DEV_ROUTES_SECRET,
      runtime,
      webPublicUrl: config.WEB_PUBLIC_URL,
    });
    app.fastify.log.info('dev routes enabled at /api/dev/*');
  }

  app.fastify.post('/api/signup', async (request, reply) => {
    try {
      const result = await messaging.signup(request.body);
      return { ok: true, bubbleNumber: result.bubbleNumber, smsLink: result.smsLink };
    } catch (err) {
      request.log.warn({ err: String(err) }, 'signup rejected');
      return reply.code(400).send({ ok: false, error: 'invalid signup' });
    }
  });

  const active = runtime.plans.findAllActive();
  if (active.length) {
    app.fastify.log.info(
      { plans: active.map((p) => ({ id: p.id, state: p.state })) },
      'resuming plans in flight',
    );
  }

  const shutdown = async (signal: string) => {
    app.fastify.log.info({ signal }, 'shutting down');
    if (startMessaging) await messaging.stop().catch(() => undefined);
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
      messaging: startMessaging ? messagingConfig.SPECTRUM_PROVIDER : 'off',
    },
    'bubbleworks server up',
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
