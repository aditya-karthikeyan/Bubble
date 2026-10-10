/**
 * Google Calendar connect (scope calendar.freebusy). Owner: P3.
 *
 * The onboarding DM carries a short link, <SERVER_PUBLIC_URL>/oauth/google/start?u=<state>,
 * which 302s to Google. Long consent URLs get truncated in chats, so the DM never carries one.
 * state is the userId plus an HMAC, so nobody can attach a calendar to someone else's bubble.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import type { Db } from '../db/client.js';
import { googleTokens } from '../db/schema.js';

export const FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';
export const START_PATH = '/oauth/google/start';
export const CALLBACK_PATH = '/oauth/google/callback';

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Must match an authorized redirect URI on the OAuth client. */
  redirectUri: string;
  /** Base for the short link, e.g. SERVER_PUBLIC_URL or http://localhost:3001. */
  publicBaseUrl: string;
  /** HMAC key for state. Defaults to clientSecret. */
  stateSecret?: string;
}

/** Reads GOOGLE_* from the environment; null when calendar connect is not configured. */
export function googleOAuthConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GoogleOAuthConfig | null {
  const clientId = env['GOOGLE_CLIENT_ID'];
  const clientSecret = env['GOOGLE_CLIENT_SECRET'];
  const base = (env['SERVER_PUBLIC_URL'] || `http://localhost:${env['PORT'] ?? 3001}`).replace(
    /\/$/,
    '',
  );
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: env['GOOGLE_REDIRECT_URI'] || `${base}${CALLBACK_PATH}`,
    publicBaseUrl: base,
  };
}

export function signState(userId: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(userId).digest('base64url').slice(0, 22);
  return `${Buffer.from(userId).toString('base64url')}.${mac}`;
}

export function verifyState(state: string, secret: string): string | null {
  const [idPart, mac] = state.split('.');
  if (!idPart || !mac) return null;
  const userId = Buffer.from(idPart, 'base64url').toString('utf8');
  const expected = signState(userId, secret).split('.')[1]!;
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? userId : null;
}

export function calendarConnectUrl(cfg: GoogleOAuthConfig, userId: string): string {
  const state = signState(userId, cfg.stateSecret ?? cfg.clientSecret);
  return `${cfg.publicBaseUrl}${START_PATH}?u=${state}`;
}

export class GoogleTokenStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  save(userId: string, tokens: Credentials): void {
    const existing = this.get(userId);
    const row = {
      userId,
      // Google sends a refresh token only on the first consent; keep the old one otherwise.
      refreshToken: tokens.refresh_token ?? existing?.refresh_token ?? null,
      accessToken: tokens.access_token ?? null,
      expiryDate: tokens.expiry_date ?? null,
      scope: tokens.scope ?? null,
      updatedAt: this.now().toISOString(),
    };
    this.db
      .insert(googleTokens)
      .values(row)
      .onConflictDoUpdate({ target: googleTokens.userId, set: row })
      .run();
  }

  get(userId: string): Credentials | null {
    const r = this.db.select().from(googleTokens).where(eq(googleTokens.userId, userId)).get();
    if (!r) return null;
    return {
      refresh_token: r.refreshToken,
      access_token: r.accessToken,
      expiry_date: r.expiryDate,
      scope: r.scope ?? undefined,
    };
  }

  has(userId: string): boolean {
    return this.get(userId)?.refresh_token != null;
  }
}

export interface GoogleOAuthRouteDeps {
  config: GoogleOAuthConfig;
  tokens: GoogleTokenStore;
  /** Called once a user's calendar is connected, e.g. to DM a confirmation. */
  onConnected?: (userId: string) => Promise<void>;
  /** Test seam: exchange an authorization code for tokens. */
  exchangeCode?: (code: string) => Promise<Credentials>;
}

export function oauthClient(cfg: GoogleOAuthConfig): OAuth2Client {
  return new OAuth2Client({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri: cfg.redirectUri,
  });
}

const page = (text: string) =>
  `<!doctype html><meta name="viewport" content="width=device-width"><title>Bubbleworks</title>` +
  `<body style="font:18px system-ui;margin:3rem auto;max-width:28rem;padding:0 1rem">${text}</body>`;

export function registerGoogleOAuthRoutes(app: FastifyInstance, deps: GoogleOAuthRouteDeps): void {
  const { config } = deps;
  const secret = config.stateSecret ?? config.clientSecret;
  const client = oauthClient(config);
  const exchange =
    deps.exchangeCode ?? (async (code: string) => (await client.getToken(code)).tokens);

  app.get<{ Querystring: { u?: string } }>(START_PATH, async (req, reply) => {
    const state = req.query.u ?? '';
    if (!verifyState(state, secret)) {
      return reply.code(400).type('text/html').send(page('That link is not valid anymore.'));
    }
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [FREEBUSY_SCOPE],
      state,
    });
    return reply.redirect(url, 302);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    CALLBACK_PATH,
    async (req, reply) => {
      const userId = verifyState(req.query.state ?? '', secret);
      if (!userId) {
        return reply.code(400).type('text/html').send(page('That link is not valid anymore.'));
      }
      if (req.query.error || !req.query.code) {
        return reply
          .type('text/html')
          .send(page('No problem, calendar not connected. You can do it later.'));
      }
      try {
        deps.tokens.save(userId, await exchange(req.query.code));
      } catch (err) {
        req.log.warn({ userId, err: (err as Error).message }, 'google token exchange failed');
        return reply.code(502).type('text/html').send(page('Google did not answer. Try again.'));
      }
      req.log.info({ userId }, 'calendar connected');
      await deps.onConnected?.(userId).catch((err: unknown) => {
        req.log.warn({ userId, err: (err as Error).message }, 'onConnected failed');
      });
      return reply
        .type('text/html')
        .send(page('Calendar connected. Your bubble only sees when you are busy, never what.'));
    },
  );
}
