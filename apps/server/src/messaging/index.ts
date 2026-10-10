/**
 * P2 messaging. createMessaging builds the MessagingPort for the configured provider.
 *
 *   SPECTRUM_PROVIDER=terminal   local TUI, no credentials, no phones (default)
 *   SPECTRUM_PROVIDER=imessage   the real Photon line: post a LINE LOCK first
 */
import type { Runtime } from '../runtime.js';
import { SpectrumMessaging } from './adapter.js';
import type { MessagingConfig } from './config.js';
import { PhotonUsers } from './photon-users.js';
import { signup, type SignupResult } from './signup.js';
import { MessagingStore } from './store.js';
import { SpectrumTransport, type Transport } from './transport.js';

export { SpectrumMessaging, dmChatId } from './adapter.js';
export { loadMessagingConfig, type MessagingConfig } from './config.js';
export { SignupInput, type SignupResult } from './signup.js';

export interface Messaging {
  port: SpectrumMessaging;
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
    openPlanCrew: async (userId) => {
      const crewIds = new Set((await runtime.crews.crewsOf(userId)).map((c) => c.id));
      return runtime.plans.findAllActive().find((p) => crewIds.has(p.groupId))?.groupId ?? null;
    },
  });

  return {
    port,
    signup: (raw) => signup({ crews: runtime.crews, photon }, raw),
    start: () => port.start(),
    stop: () => port.stop(),
  };
}
