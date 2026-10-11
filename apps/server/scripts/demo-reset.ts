/**
 * pnpm demo:reset
 * Clears plans and plan-scoped state in the configured database, restores the seeded ledger,
 * keeps users, facts, crews, venues. Pass --remote to hit Railway's dev route instead
 * (needs DEV_ROUTES_SECRET and SERVER_PUBLIC_URL in .env).
 */
import { loadConfig } from '../src/config.js';
import { demoReset } from '../src/dev/demo-reset.js';
import { createRuntime } from '../src/runtime.js';

async function main(): Promise<void> {
  if (process.argv.includes('--remote')) {
    const base = process.env['SERVER_PUBLIC_URL']?.replace(/\/$/, '');
    const secret = process.env['DEV_ROUTES_SECRET'];
    if (!base || !secret) throw new Error('--remote needs SERVER_PUBLIC_URL and DEV_ROUTES_SECRET');
    const res = await fetch(`${base}/api/dev/reset`, {
      method: 'POST',
      headers: { 'x-dev-secret': secret },
    });
    console.log(res.status, await res.text());
    return;
  }
  const config = loadConfig();
  const rt = createRuntime(config, { seed: true });
  const result = demoReset(rt.db);
  console.log(JSON.stringify(result));
  console.log(
    `reset ${config.DATABASE_PATH}: plans cleared, ledger restored, users and venues kept`,
  );
  rt.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
