/**
 * P2 messaging. createMessaging builds the MessagingPort for the configured provider, and
 * attachEngine connects it to the PlanEngine (detection, bundle, headcount, votes).
 *
 *   SPECTRUM_PROVIDER=terminal   local TUI, no credentials, no phones (default)
 *   SPECTRUM_PROVIDER=imessage   the real Photon line: post a LINE LOCK first
 *
 * Server wiring (P1):
 *   const messaging = createMessaging({ config: loadMessagingConfig(), runtime });
 *   const intake = messaging.attachEngine(engine);   // engine: PlanEngine
 *   await messaging.start();
 *   // question policy: await intake.renderBundle(decision)
 *   // POST /api/signup -> messaging.signup(body)
 */
import { crewChatId, type PlanEngine } from '@bubbleworks/shared';
import type { Runtime } from '../runtime.js';
import { SpectrumMessaging } from './adapter.js';
import { BundleStore } from './bundle.js';
import { ClaudeClassifier, type Classifier } from './classifier.js';
import type { MessagingConfig } from './config.js';
import { PlanIntake } from './intake.js';
import { PhotonUsers } from './photon-users.js';
import { signup, type SignupResult } from './signup.js';
import { MessagingStore } from './store.js';
import { SpectrumTransport, type Transport } from './transport.js';

export { SpectrumMessaging, dmChatId } from './adapter.js';
export { type BundleResult, type QuestionDecision } from './bundle.js';
export { loadMessagingConfig, type MessagingConfig } from './config.js';
export { PlanIntake } from './intake.js';
export { SignupInput, type SignupResult } from './signup.js';

export interface Messaging {
  port: SpectrumMessaging;
  bundles: BundleStore;
  /** Wire inbound messages to the engine. Call once, before start(). */
  attachEngine(engine: PlanEngine, options?: { classifier?: Classifier | null }): PlanIntake;
  /** One-time registration: Photon user + bubble number + CrewDirectory user. */
  signup(raw: unknown): Promise<SignupResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateMessagingOptions {
  config: MessagingConfig;
  runtime: Pick<Runtime, 'handle' | 'crews' | 'plans' | 'log'>;
  /** Test and sim override. */
  transport?: Transport;
}

export function createMessaging(options: CreateMessagingOptions): Messaging {
  const { config, runtime } = options;
  const log = runtime.log;
  const transport =
    options.transport ??
    new SpectrumTransport({
      provider: config.SPECTRUM_PROVIDER,
      projectId: config.SPECTRUM_PROJECT_ID,
      projectSecret: config.SPECTRUM_PROJECT_SECRET,
      terminalDefaultPhone: config.MESSAGING_TERMINAL_PHONE,
      log: (obj, msg) => log.warn(obj, msg),
    });
  const photon =
    transport.provider === 'imessage' &&
    config.SPECTRUM_PROJECT_ID &&
    config.SPECTRUM_PROJECT_SECRET
      ? new PhotonUsers({
          apiUrl: config.SPECTRUM_API_URL,
          projectId: config.SPECTRUM_PROJECT_ID,
          projectSecret: config.SPECTRUM_PROJECT_SECRET,
        })
      : null;
  const bundles = new BundleStore(runtime.handle.sqlite);

  const port = new SpectrumMessaging({
    transport,
    crews: runtime.crews,
    store: new MessagingStore(runtime.handle.sqlite),
    log,
    debounceMs: config.MESSAGING_DEBOUNCE_MS,
    // P1's PlanStore owns the per-member budget. Keys whose prefix is not a plan spend nothing.
    spendMessage: (planId, userId) => {
      try {
        return runtime.plans.spendMessage(planId, userId) >= 0;
      } catch {
        return true;
      }
    },
    // A member's DMs belong to their crew's plan while it is collecting answers.
    openPlanCrew: async (userId) => {
      const crews = await runtime.crews.crewsOf(userId);
      const withBundle = crews.find((c) => bundles.openForChat(crewChatId(c.id)));
      if (withBundle) return withBundle.id;
      const crewIds = new Set(crews.map((c) => c.id));
      return runtime.plans.findAllActive().find((p) => crewIds.has(p.groupId))?.groupId ?? null;
    },
  });

  let intake: PlanIntake | null = null;
  return {
    port,
    bundles,
    attachEngine(engine, attachOptions = {}) {
      if (intake) throw new Error('engine already attached');
      const classifier =
        attachOptions.classifier !== undefined
          ? attachOptions.classifier
          : process.env['ANTHROPIC_API_KEY']
            ? new ClaudeClassifier({ log })
            : null;
      if (!classifier) log.warn({}, 'no ANTHROPIC_API_KEY: plan detection runs on rules only');
      intake = new PlanIntake({ port, engine, bundles, classifier, log });
      intake.start();
      return intake;
    },
    signup: (raw) => signup({ crews: runtime.crews, photon }, raw),
    start: () => port.start(),
    stop: () => port.stop(),
  };
}
