import { z } from 'zod';

const E164 = z.string().regex(/^\+[1-9]\d{7,14}$/);

const Env = z
  .object({
    /** fake: FakeCaller, no phone rings. real: ElevenLabs over Twilio. */
    CALLER_MODE: z.enum(['fake', 'real']).default('fake'),
    ELEVENLABS_API_KEY: z.string().min(1).optional(),
    ELEVENLABS_AGENT_ID: z.string().min(1).optional(),
    ELEVENLABS_PHONE_NUMBER_ID: z.string().min(1).optional(),
    /** Post-call webhook HMAC secret. The webhook route is only registered when set. */
    ELEVENLABS_WEBHOOK_SECRET: z.string().min(1).optional(),
    /** The caller's own number, read to the venue as the callback number. */
    TWILIO_PHONE_NUMBER: E164.optional(),
    /**
     * Comma-separated E.164 numbers real mode may dial, on top of the demo venue. Real venues in
     * data/venues.json are real restaurants, so nothing else rings without being listed here.
     */
    CALLER_ALLOWED_NUMBERS: z
      .string()
      .default('')
      .transform((s) =>
        s
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean),
      )
      .pipe(z.array(E164)),
    CALLER_RING_TIMEOUT_S: z.coerce.number().int().min(5).max(60).default(20),
    /** Venue-local time zone for the times the agent says and hears. */
    CALLER_TIMEZONE: z.string().default('America/New_York'),
    /** Poll each live call this often as a fallback to the webhook. 0 disables polling. */
    CALLER_POLL_MS: z.coerce.number().int().min(0).default(3000),
  })
  .refine(
    (env) =>
      env.CALLER_MODE !== 'real' ||
      (env.ELEVENLABS_API_KEY !== undefined &&
        env.ELEVENLABS_AGENT_ID !== undefined &&
        env.ELEVENLABS_PHONE_NUMBER_ID !== undefined),
    {
      message:
        'CALLER_MODE=real needs ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID and ELEVENLABS_PHONE_NUMBER_ID',
    },
  );

export type CallerConfig = z.infer<typeof Env>;

export function loadCallerConfig(env: NodeJS.ProcessEnv = process.env): CallerConfig {
  // Empty strings from .env files count as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const result = Env.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid caller environment: ${issues}`);
  }
  return result.data;
}
