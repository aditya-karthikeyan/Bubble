/**
 * P3 bubbles, wired from the runtime. Server entry (P1) does:
 *
 *   const bubbles = createBubbles({ runtime, messaging: messaging.port });
 *   bubbles.registerRoutes(app.fastify);            // Google calendar connect
 *   messaging.port.onPrivateMessage(async (m) => {
 *     const { handled } = await bubbles.service.onPrivateMessage(m);
 *     if (!handled) { ...engine command handling... }
 *   });
 *   createRuntime(config, { hardFacts: (id) => bubbles.service.getHardLimits(id) });
 */
import type { FastifyInstance } from 'fastify';
import type { CrewDirectory, MessagingPort, Unsubscribe } from '@bubbleworks/shared';
import type { Db } from '../db/client.js';
import type { Logger } from '../events/bus.js';
import { HaikuExtractor, RuleExtractor, type FactExtractor } from './extract.js';
import {
  calendarConnectUrl,
  googleOAuthConfigFromEnv,
  GoogleTokenStore,
  registerGoogleOAuthRoutes,
  type GoogleOAuthConfig,
} from './google-oauth.js';
import { HaikuReactionClassifier, RuleReactionClassifier } from './reactions.js';
import { DbBubbleService, type BubbleServiceDeps } from './service.js';
import { GoogleFreeBusySource, PhotonLocationSource, type LocationSource } from './signals.js';

export { DbBubbleService } from './service.js';
export { FactStore, describeFact } from './facts.js';
export { HaikuExtractor, RuleExtractor, resolveUntil } from './extract.js';

export interface CreateBubblesOptions {
  runtime: { db: Db; crews: CrewDirectory; log: Logger };
  messaging: Pick<MessagingPort, 'sendPrivateText'> &
    Partial<Pick<MessagingPort, 'onGroupMessage'>>;
  env?: NodeJS.ProcessEnv;
  extractor?: FactExtractor;
  /** Overrides the Find My source built from SPECTRUM_PROJECT_*; null disables it. */
  locations?: LocationSource | null;
  onCrewChanged?: BubbleServiceDeps['onCrewChanged'];
  now?: () => Date;
}

export interface Bubbles {
  service: DbBubbleService;
  tokens: GoogleTokenStore;
  google: GoogleOAuthConfig | null;
  registerRoutes(app: FastifyInstance): void;
  /** Learn from crew plan messages too (they reach onGroupMessage, not the bubble). */
  attachLearner(): Unsubscribe | null;
  close(): Promise<void>;
}

export function createBubbles(options: CreateBubblesOptions): Bubbles {
  const env = options.env ?? process.env;
  const { db, crews, log } = options.runtime;
  const google = googleOAuthConfigFromEnv(env);
  const tokens = new GoogleTokenStore(db, options.now);
  const extractor =
    options.extractor ??
    (env['ANTHROPIC_API_KEY']
      ? new HaikuExtractor({ apiKey: env['ANTHROPIC_API_KEY'] })
      : new RuleExtractor());
  const webBase = env['WEB_PUBLIC_URL']?.replace(/\/$/, '');
  const photonId = env['SPECTRUM_PROJECT_ID'];
  const photonSecret = env['SPECTRUM_PROJECT_SECRET'];
  const photon =
    options.locations === undefined && photonId && photonSecret
      ? new PhotonLocationSource(photonId, photonSecret)
      : null;
  const locations = options.locations === undefined ? photon : options.locations;

  const service = new DbBubbleService({
    db,
    crews,
    messaging: options.messaging,
    extractor,
    calendarLink: (userId) => (google ? calendarConnectUrl(google, userId) : null),
    signupUrl: webBase ?? null,
    joinBaseUrl: env['SERVER_PUBLIC_URL']?.replace(/\/$/, '') ?? webBase ?? null,
    locations,
    freeBusy: google ? new GoogleFreeBusySource(google, tokens) : null,
    reactions: env['ANTHROPIC_API_KEY']
      ? new HaikuReactionClassifier({ apiKey: env['ANTHROPIC_API_KEY'] })
      : new RuleReactionClassifier(),
    ...(options.onCrewChanged ? { onCrewChanged: options.onCrewChanged } : {}),
    ...(options.now ? { now: options.now } : {}),
    log,
  });

  return {
    service,
    tokens,
    google,
    attachLearner() {
      const on = options.messaging.onGroupMessage?.bind(options.messaging);
      if (!on) return null;
      return on(async (m) => {
        service.learn({ messageId: m.messageId, userId: m.userId, text: m.text, at: m.at });
      });
    },
    async close() {
      await photon?.close();
    },
    registerRoutes(app) {
      if (!google) {
        log.warn({}, 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET unset: calendar connect disabled');
        return;
      }
      registerGoogleOAuthRoutes(app, {
        config: google,
        tokens,
        onConnected: async (userId) => {
          await options.messaging.sendPrivateText({
            userId,
            text: 'Calendar connected. I only see when you are busy, never what.',
            idempotencyKey: `bubble:${userId}:calendar-connected:${Date.now()}`,
          });
        },
      });
    },
  };
}
