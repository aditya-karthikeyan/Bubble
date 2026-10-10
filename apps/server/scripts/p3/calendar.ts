/**
 * P3 Phase 0 spike: Google OAuth (calendar.freebusy) and tonight's free/busy.
 * `pnpm p3:oauth` runs one flow on localhost:3000. Tokens land in .tokens/ (gitignored).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import { z } from 'zod';

const SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';
const TOKEN_DIR = '../../.tokens';
const TOKEN_FILE = `${TOKEN_DIR}/google-spike.json`;
const DEFAULT_REDIRECT = 'http://localhost:3000/oauth/google/callback';

const FreeBusyResponse = z.object({
  calendars: z.record(
    z.string(),
    z.object({
      busy: z.array(z.object({ start: z.string(), end: z.string() })),
      errors: z.array(z.unknown()).optional(),
    }),
  ),
});

function client(): OAuth2Client {
  const clientId = process.env['GOOGLE_CLIENT_ID'];
  const clientSecret = process.env['GOOGLE_CLIENT_SECRET'];
  if (!clientId || !clientSecret)
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing');
  const redirectUri = process.env['GOOGLE_REDIRECT_URI'] || DEFAULT_REDIRECT;
  return new OAuth2Client({ clientId, clientSecret, redirectUri });
}

/**
 * Serves a short start URL that 302s to Google. Long consent URLs get truncated when clicked
 * from a terminal or chat, which drops response_type.
 */
export async function runOAuthFlow(userId = 'spike-user'): Promise<void> {
  const oauth = client();
  const url = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [SCOPE],
    state: userId,
  });
  console.log('\nOpen this link and approve calendar free/busy access:');
  console.log('http://localhost:3000/oauth/google/start\n');
  await new Promise<void>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://localhost:3000');
      if (u.pathname === '/oauth/google/start') {
        res.writeHead(302, { location: url }).end();
        return;
      }
      if (u.pathname !== '/oauth/google/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = u.searchParams.get('code');
      if (!code) {
        res.writeHead(400).end('missing code');
        return;
      }
      oauth
        .getToken(code)
        .then(({ tokens }) => {
          mkdirSync(TOKEN_DIR, { recursive: true });
          writeFileSync(
            TOKEN_FILE,
            JSON.stringify({ userId: u.searchParams.get('state'), tokens }),
          );
          res
            .writeHead(200, { 'content-type': 'text/plain' })
            .end('Calendar connected. Close this tab.');
          server.close();
          resolve();
        })
        .catch((err: unknown) => {
          res.writeHead(500).end('token exchange failed');
          server.close();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
    server.listen(3000);
  });
  console.log('OAuth complete, tokens saved.');
}

export interface FreeBusyTonight {
  busy: Array<{ start: string; end: string }>;
  window: { from: string; to: string };
  ms: number;
}

/** Free/busy for tonight (17:00 to 23:59 local) on the primary calendar. */
export async function getFreeBusyTonight(): Promise<FreeBusyTonight> {
  if (!existsSync(TOKEN_FILE)) throw new Error('no calendar tokens yet; run pnpm p3:oauth');
  const { tokens } = JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as { tokens: Credentials };
  const oauth = client();
  oauth.setCredentials(tokens);

  const from = new Date();
  from.setHours(17, 0, 0, 0);
  const to = new Date();
  to.setHours(23, 59, 0, 0);

  const t0 = performance.now();
  const res = await oauth.request({
    url: 'https://www.googleapis.com/calendar/v3/freeBusy',
    method: 'POST',
    data: { timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: 'primary' }] },
  });
  const ms = Math.round(performance.now() - t0);
  const parsed = FreeBusyResponse.parse(res.data);
  return {
    busy: parsed.calendars['primary']?.busy ?? [],
    window: { from: from.toISOString(), to: to.toISOString() },
    ms,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await runOAuthFlow();
  console.log(JSON.stringify(await getFreeBusyTonight(), null, 2));
}
