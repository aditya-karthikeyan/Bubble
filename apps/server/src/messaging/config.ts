import { z } from 'zod';

const Env = z
  .object({
    /** terminal for local development; imessage only on the process holding the LINE LOCK. */
    SPECTRUM_PROVIDER: z.enum(['terminal', 'imessage']).default('terminal'),
    SPECTRUM_PROJECT_ID: z.string().min(1).optional(),
    SPECTRUM_PROJECT_SECRET: z.string().min(1).optional(),
    /** Spectrum management API, used to register users and read their bubble numbers. */
    SPECTRUM_API_URL: z.url().default('https://spectrum.photon.codes'),
    /** Hold one sender's messages this long and deliver them as one batch. */
    MESSAGING_DEBOUNCE_MS: z.coerce.number().int().min(0).default(1500),
    /** Terminal provider only: the phone that typing in the default chat speaks as. */
    MESSAGING_TERMINAL_PHONE: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/)
      .optional(),
    /** app: iMessage app card with a page preview (default). richlink: bare URL bubble. */
    MESSAGING_LINK_STYLE: z.enum(['app', 'richlink']).default('app'),
  })
  .refine(
    (env) =>
      env.SPECTRUM_PROVIDER !== 'imessage' ||
      (env.SPECTRUM_PROJECT_ID !== undefined && env.SPECTRUM_PROJECT_SECRET !== undefined),
    { message: 'SPECTRUM_PROVIDER=imessage needs SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET' },
  );

export type MessagingConfig = z.infer<typeof Env>;

export function loadMessagingConfig(env: NodeJS.ProcessEnv = process.env): MessagingConfig {
  // Empty strings from .env files count as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const result = Env.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid messaging environment: ${issues}`);
  }
  return result.data;
}
