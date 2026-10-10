/**
 * P4 caller. createCaller picks the FakeCaller (CALLER_MODE=fake, default) or the ElevenLabs
 * adapter (CALLER_MODE=real). The engine talks to `port`; results arrive through `onResult`.
 *
 *   const caller = createCaller({ config: loadCallerConfig(), runtime, onResult: (r) => engine.handleCallResult(r) });
 *   await caller.registerWebhook(app.fastify);   // no-op without ELEVENLABS_WEBHOOK_SECRET
 *   caller.start();
 */
import type { CallerPort } from '@bubbleworks/shared';
import { FakeCaller } from '@bubbleworks/shared/fakes';
import type { FastifyInstance } from 'fastify';
import type { Runtime } from '../runtime.js';
import { ElevenLabsCaller, type CallResultSink } from './adapter.js';
import type { CallerConfig } from './config.js';
import { ElevenLabsHttp, type ElevenLabsApi } from './elevenlabs.js';
import { CallerStore } from './store.js';
import { registerCallerWebhook } from './webhook.js';

export { ElevenLabsCaller, type CallResultSink, type WebhookOutcome } from './adapter.js';
export { loadCallerConfig, type CallerConfig } from './config.js';
export { WEBHOOK_PATH } from './webhook.js';

export interface Caller {
  mode: CallerConfig['CALLER_MODE'];
  port: CallerPort;
  registerWebhook(app: FastifyInstance): Promise<boolean>;
  start(): void;
  stop(): void;
}

export interface CreateCallerOptions {
  config: CallerConfig;
  runtime: Pick<Runtime, 'handle' | 'bus' | 'log'>;
  onResult: CallResultSink;
  /** Test override for the ElevenLabs HTTP client. */
  api?: ElevenLabsApi;
}

export function createCaller(options: CreateCallerOptions): Caller {
  const { config, runtime, onResult } = options;
  if (config.CALLER_MODE === 'fake') {
    const fake = new FakeCaller(onResult, { log: (line) => runtime.log.info({}, line) });
    return {
      mode: 'fake',
      port: fake,
      registerWebhook: async () => false,
      start: () => undefined,
      stop: () => fake.dispose(),
    };
  }
  const api =
    options.api ??
    new ElevenLabsHttp({
      apiKey: config.ELEVENLABS_API_KEY!,
      agentId: config.ELEVENLABS_AGENT_ID!,
      phoneNumberId: config.ELEVENLABS_PHONE_NUMBER_ID!,
    });
  const caller = new ElevenLabsCaller({
    api,
    store: new CallerStore(runtime.handle.sqlite),
    bus: runtime.bus,
    onResult,
    config,
    log: runtime.log,
  });
  return {
    mode: 'real',
    port: caller,
    async registerWebhook(app) {
      if (!config.ELEVENLABS_WEBHOOK_SECRET) {
        runtime.log.warn({}, 'ELEVENLABS_WEBHOOK_SECRET unset: caller relies on polling only');
        return false;
      }
      await registerCallerWebhook(app, { secret: config.ELEVENLABS_WEBHOOK_SECRET, caller });
      return true;
    },
    start: () => caller.start(),
    stop: () => caller.stop(),
  };
}
