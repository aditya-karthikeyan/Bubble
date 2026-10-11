import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  SERVER_PUBLIC_URL: z.url().optional(),
  WEB_PUBLIC_URL: z.url().optional(),
  DATABASE_PATH: z.string().default('./data/bubbleworks.db'),
  DEMO_MODE: z.stringbool().default(false),
  /**
   * polls: headcount by tap, then sit-down/fast-food and cuisine polls. agent_first: one message
   * to a bubble starts it, nobody taps anything (opt-out headcount), no polls, sit-down places
   * within a drive, the bubbles deliberate, and the person hears back when it is booked.
   */
  FLOW: z.enum(['polls', 'agent_first']).default('polls'),
  /** With DEMO_MODE, plan start times as if it were this local time (HH:MM), e.g. 18:00. */
  DEMO_PLAN_CLOCK: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, e.g. 18:00')
    .optional(),
  /** Google Places API (New) key: live restaurants are searched when a plan starts. */
  GOOGLE_PLACES_KEY: z.string().min(10).optional(),
  /** Upsert personas, the demo group, and venues at boot. Idempotent. */
  SEED_ON_BOOT: z.stringbool().default(true),
  /**
   * Enables POST /api/dev/* (create and step a demo plan) when set; requests must send the
   * same value in the x-dev-secret header. Unset = routes absent.
   */
  DEV_ROUTES_SECRET: z.string().min(16).optional(),
  /** E.164 number of the teammate who plays the demo venue. Never committed. */
  DEMO_VENUE_PHONE: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, 'E.164, e.g. +17045551234')
    .optional(),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // A blank line copied from .env.example (SERVER_PUBLIC_URL=) means unset, not an invalid value.
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const result = Env.safeParse(set);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return result.data;
}
