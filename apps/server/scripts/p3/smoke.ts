/**
 * pnpm p3:smoke [url]
 * Checks every P3 surface on a deployed server (default SERVER_PUBLIC_URL, else Railway) and the
 * local keys the server needs. Prints PASS / FAIL with a fix for each. Never prints secrets.
 *
 * - /health answers
 * - calendar connect: a signed /oauth/google/start link 302s to Google with this server's
 *   callback (needs the same GOOGLE_CLIENT_SECRET locally as on the server)
 * - /ics route is deployed (P3 Phase 3): a forged token gets the handler's 404, not "route not found"
 * - Anthropic key answers (Haiku)
 * - Photon project mints a shared Advanced iMessage token (Find My)
 */
import Anthropic from '@anthropic-ai/sdk';
import { cloud } from 'spectrum-ts';
import { signState } from '../../src/bubbles/google-oauth.js';

const base = (
  process.argv[2] ||
  process.env['SMOKE_URL'] ||
  process.env['SERVER_PUBLIC_URL'] ||
  'https://server-production-6ba5.up.railway.app'
).replace(/\/$/, '');

type Result = { check: string; ok: boolean; detail: string };
const results: Result[] = [];
const check = async (name: string, fn: () => Promise<string>) => {
  try {
    results.push({ check: name, ok: true, detail: await fn() });
  } catch (err) {
    results.push({ check: name, ok: false, detail: (err as Error).message });
  }
};
const get = (path: string) =>
  fetch(`${base}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });

console.log(`target: ${base}\n`);

await check('server /health', async () => {
  const res = await get('/health');
  const body = (await res.json()) as { ok?: boolean; activePlans?: number; venues?: number };
  if (!res.ok || !body.ok) throw new Error(`status ${res.status}`);
  return `ok, ${body.venues ?? '?'} venues, ${body.activePlans ?? 0} active plans`;
});

await check('calendar connect route', async () => {
  const secret = process.env['GOOGLE_CLIENT_SECRET'];
  if (!secret) throw new Error('GOOGLE_CLIENT_SECRET not set locally, cannot sign a test link');
  const res = await get(`/oauth/google/start?u=${signState('user_ava', secret)}`);
  if (res.status === 404) {
    throw new Error(
      '404: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server and redeploy',
    );
  }
  if (res.status === 400) {
    throw new Error("400: the server's GOOGLE_CLIENT_SECRET differs from the local one");
  }
  if (res.status !== 302) throw new Error(`expected 302, got ${res.status}`);
  const to = new URL(res.headers.get('location') ?? '');
  const redirect = to.searchParams.get('redirect_uri');
  if (to.hostname !== 'accounts.google.com') throw new Error(`redirects to ${to.hostname}`);
  if (redirect !== `${base}/oauth/google/callback`) {
    throw new Error(
      `redirect_uri is ${redirect}; set GOOGLE_REDIRECT_URI=${base}/oauth/google/callback on the server`,
    );
  }
  return `302 to Google, redirect_uri ${redirect}`;
});

await check('calendar invite (.ics) route', async () => {
  const res = await get('/ics/x.y.ics');
  const body = await res.text();
  if (res.status === 404 && /Route GET:\/ics/.test(body)) {
    throw new Error('route not deployed: merge P3 Phase 3 (#15) and redeploy');
  }
  if (res.status !== 404) throw new Error(`forged token should 404, got ${res.status}`);
  return 'deployed (forged token rejected)';
});

await check('Anthropic key (Haiku)', async () => {
  if (!process.env['ANTHROPIC_API_KEY']) throw new Error('ANTHROPIC_API_KEY not set locally');
  const t0 = performance.now();
  await new Anthropic().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 5,
    messages: [{ role: 'user', content: 'Say ok.' }],
  });
  return `answers in ${Math.round(performance.now() - t0)} ms`;
});

await check('Photon Find My token', async () => {
  const id = process.env['SPECTRUM_PROJECT_ID'];
  const secret = process.env['SPECTRUM_PROJECT_SECRET'];
  if (!id || !secret) throw new Error('SPECTRUM_PROJECT_ID / SECRET not set locally');
  const t = await cloud.issueImessageTokens(id, secret);
  if (t.type !== 'shared') throw new Error(`expected a shared token, got ${t.type}`);
  return `shared token, ${t.expiresIn} s`;
});

for (const r of results)
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check.padEnd(30)} ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
