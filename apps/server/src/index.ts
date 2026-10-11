import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { idempotencyKey } from '@bubbleworks/shared';
import { FakeMessaging } from '@bubbleworks/shared/fakes';
import { createBubbles } from './bubbles/index.js';
import { createCaller, loadCallerConfig } from './caller/index.js';
import { seedDemoBubbles } from './bubbles/seed.js';
import { registerDevRoutes } from './dev/routes.js';
import { Doers } from './doers/index.js';
import { parseCommand } from './engine/intent.js';
import { HaikuAskWriter } from './engine/wording.js';
import { demoPlanningClock } from './engine/demo-clock.js';
import { BubbleworksEngine } from './engine/plan-engine.js';
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
  // Real calls run long: with CALLER_MODE=real the call timeout is 5 minutes (P4's measurement),
  // in both normal and DEMO_MODE deadlines. Fake calls keep the configured 90 s / 60 s.
  const realCalls = process.env['CALLER_MODE'] === 'real';
  const runtime = createRuntime(config, {
    log: app.fastify.log,
    ...(realCalls ? { timers: { deadlines: { call_ms: 300_000 } } } : {}),
  });
  pending.runtime = runtime;
  runtime.bus.setBroadcaster((token, event) => app.live.broadcast(token, event));
  runtime.timers.start();

  // P2 messaging adapter. The terminal provider is Spectrum's local TUI, so it only starts
  // when there is a terminal to draw on; the real line starts only when SPECTRUM_PROVIDER=imessage
  // is set on the process holding the LINE LOCK. Signup works either way.
  const messagingConfig = loadMessagingConfig();
  const messaging = createMessaging({ config: messagingConfig, runtime });
  const startMessaging = messagingConfig.SPECTRUM_PROVIDER === 'imessage' || process.stdin.isTTY;

  // P3 bubbles: facts, onboarding, crews over DM, passive learning, calendar connect. They
  // replace the facts-table read for the candidate precompute.
  const bubbles = createBubbles({ runtime, messaging: messaging.port });
  runtime.setHardFacts((userId) => bubbles.service.getHardLimits(userId));
  bubbles.registerRoutes(app.fastify);
  bubbles.attachLearner();
  if (runtime.seed) {
    app.fastify.log.info({ ...seedDemoBubbles(runtime.db) }, 'demo bubbles seeded');
  }

  // P1 engine. P4 caller: FakeCaller unless CALLER_MODE=real (ElevenLabs over Twilio). Doers are P3's.
  const engineRef: { engine: BubbleworksEngine | null } = { engine: null };
  const caller = createCaller({
    config: loadCallerConfig(),
    runtime,
    onResult: (result) => engineRef.engine!.handleCallResult(result),
  });
  // With the transport off (headless, no line lock) the engine talks to a silent fake so plans
  // started from the dev routes still run end to end for the live page.
  const enginePort = startMessaging
    ? messaging.port
    : new FakeMessaging({ print: false, log: (line) => app.fastify.log.debug(line) });
  if (!startMessaging) app.fastify.log.info('engine messaging: silent fake (transport off)');

  // P3 doers: Inviter (.ics link), Splitter (Venmo, ledger), Watcher (ETAs, lateness), and the
  // private summary for represented members. Lateness asks the caller to hold the table.
  const publicBase = (config.SERVER_PUBLIC_URL ?? `http://localhost:${config.PORT}`).replace(
    /\/$/,
    '',
  );
  const doers = new Doers({
    db: runtime.db,
    crews: runtime.crews,
    bubbles: bubbles.service,
    messaging: enginePort,
    timers: runtime.timers,
    bus: runtime.bus,
    publicBaseUrl: publicBase,
    linkSecret:
      process.env['GOOGLE_CLIENT_SECRET'] || process.env['SPECTRUM_PROJECT_SECRET'] || 'dev-only',
    onLate: async (n) => {
      const venue = runtime.venues().find((v) => v.id === n.venueId);
      if (!venue) return;
      await caller.port.holdTable({
        planId: n.planId,
        bookingId: n.bookingId,
        venue,
        partySize: n.partySize,
        startAt: n.startAt,
        holdMinutes: Math.min(30, n.minutesLate + 5),
        idempotencyKey: idempotencyKey(n.planId, 'hold_table', n.bookingId),
      });
    },
    log: app.fastify.log,
  });
  doers.registerRoutes(app.fastify);
  const engine = new BubbleworksEngine({
    runtime,
    bubbles: bubbles.service,
    messaging: enginePort,
    caller: caller.port,
    doers,
    webPublicUrl: config.WEB_PUBLIC_URL ?? null,
    log: app.fastify.log,
    ...(config.DEMO_MODE && config.DEMO_PLAN_CLOCK
      ? { planningNow: demoPlanningClock(config.DEMO_PLAN_CLOCK) }
      : {}),
    ...(process.env['ANTHROPIC_API_KEY']
      ? { askWriter: new HaikuAskWriter({ apiKey: process.env['ANTHROPIC_API_KEY'] }) }
      : {}),
  });
  engineRef.engine = engine;
  // POST /webhooks/elevenlabs, only in real mode with ELEVENLABS_WEBHOOK_SECRET set; polling covers the rest.
  if (await caller.registerWebhook(app.fastify))
    app.fastify.log.info('elevenlabs webhook at /webhooks/elevenlabs');
  caller.start();
  app.fastify.log.info({ mode: caller.mode }, 'caller ready');
  const intake = messaging.attachEngine(engine);
  engine.setIntake(intake);

  // Private DMs: the bubble answers first; what it does not handle may be a plan command.
  messaging.port.onPrivateMessage(async (m) => {
    // A pending concession ask takes the next yes/no from that person.
    const pending = engine.pendingAskFor(m.userId);
    const yn = /^\s*(y|yes|yeah|yep|sure|ok|okay|fine|deal)\b/i.test(m.text)
      ? 'yes'
      : /^\s*(n|no|nope|nah|can'?t|cannot|rather not)\b/i.test(m.text)
        ? 'no'
        : null;
    if (pending && yn) {
      await engine.handleAskAnswer({
        askId: pending.askId,
        userId: m.userId,
        answer: yn,
        rawText: m.text,
        at: m.at,
      });
      return;
    }
    const { handled } = await bubbles.service.onPrivateMessage(m);
    if (handled) return;
    const command = parseCommand(m.text);
    if (!command) return;
    const crews = await runtime.crews.crewsOf(m.userId);
    const chatId = crews.find((c) => c.status === 'active')?.chatId ?? crews[0]?.chatId;
    if (!chatId) return;
    await engine.handleCommand({
      chatId,
      userId: m.userId,
      command,
      messageId: m.messageId,
      at: m.at,
    });
  });

  if (startMessaging) await messaging.start();
  else app.fastify.log.info('messaging transport not started: terminal provider without a TTY');

  // Plans in flight resume from their persisted state and timers.
  for (const plan of runtime.plans.findAllActive()) await engine.kick(plan.id);

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
    caller.stop();
    if (startMessaging) await messaging.stop().catch(() => undefined);
    await bubbles.close().catch(() => undefined);
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
