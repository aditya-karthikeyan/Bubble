/**
 * pnpm p4:calltest [--only N]
 * Five real calls through the ElevenLabs caller to TEST_CALL_NUMBER, with a teammate playing the
 * restaurant: available, full with a time inside the window, full all night, voicemail, deposit.
 * Runs the real adapter against an in-memory database and waits for each result (polling, so no
 * public webhook is needed). Prints a results table.
 */
import { createInterface } from 'node:readline/promises';
import type { CallOutcome, CallResult } from '@bubbleworks/shared';
import { ElevenLabsCaller } from '../../src/caller/adapter.js';
import { loadCallerConfig } from '../../src/caller/config.js';
import { ElevenLabsHttp } from '../../src/caller/elevenlabs.js';
import { CallerStore } from '../../src/caller/store.js';
import { INTENT, testRuntime } from '../../src/test-helpers.js';
import { demoVenue } from '../../src/venues/demo-venue.js';
import { env } from './lib.js';

const SCENARIOS: { name: string; script: string; expect: CallOutcome }[] = [
  { name: 'table available', script: 'Say yes, a table for 4 at 7 works.', expect: 'booked' },
  { name: 'full, 7:30 open', script: 'Say 7 is full, but you can do 7:30.', expect: 'booked' },
  {
    name: 'full all night',
    script: "Say you're fully booked tonight, no waitlist.",
    expect: 'declined',
  },
  { name: 'voicemail', script: "Don't answer. Let it ring out to voicemail.", expect: 'no_answer' },
  {
    name: 'deposit',
    script: 'Say you need a card for a $20 deposit to hold it.',
    expect: 'needs_human',
  },
];

async function main(): Promise<void> {
  // Test-number calls: everyone on the line knows it's the agent, so no disclosure.
  const config = loadCallerConfig({
    ...process.env,
    CALLER_MODE: 'real',
    CALLER_DISCLOSE: 'false',
  });
  const only = process.argv.includes('--only')
    ? Number(process.argv[process.argv.indexOf('--only') + 1])
    : null;
  const rt = testRuntime();
  const plan = rt.plans.create({
    groupId: 'group_demo',
    chatId: 'crew:group_demo',
    intent: INTENT,
    createdByUserId: 'user_ava',
    demoMode: true,
  });

  let resolveResult: ((r: CallResult) => void) | null = null;
  const caller = new ElevenLabsCaller({
    api: new ElevenLabsHttp({
      apiKey: env('ELEVENLABS_API_KEY'),
      agentId: env('ELEVENLABS_AGENT_ID'),
      phoneNumberId: env('ELEVENLABS_PHONE_NUMBER_ID'),
    }),
    store: new CallerStore(rt.handle.sqlite),
    bus: rt.bus,
    onResult: async (r) => resolveResult?.(r),
    config: { ...config, CALLER_POLL_MS: config.CALLER_POLL_MS || 3000 },
    log: {
      info: () => undefined,
      debug: () => undefined,
      warn: (o, m) => console.warn(m, o),
      error: (o, m) => console.error(m, o),
    },
  });
  caller.start();

  const venue = demoVenue(env('TEST_CALL_NUMBER'));
  // Tonight at 7 PM venue-local, as the booking request carries it.
  const startAt = new Date(`${new Date().toISOString().slice(0, 10)}T23:00:00.000Z`).toISOString();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const rows: string[][] = [];

  for (const [i, s] of SCENARIOS.entries()) {
    if (only !== null && only !== i + 1) continue;
    await rl.question(`\n${i + 1}/5 ${s.name}. Teammate: ${s.script}\nPress Enter to dial... `);
    const t0 = Date.now();
    const result = new Promise<CallResult>((resolve) => (resolveResult = resolve));
    await caller.book({
      planId: plan.id,
      bookingId: `calltest_${i + 1}`,
      venue,
      backupVenue: null,
      partySize: 4,
      startAt,
      reservationName: 'Mahil',
      tableNotes: [],
      idempotencyKey: `calltest:${Date.now()}:${i + 1}`,
    });
    const r = await Promise.race([
      result,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 6 * 60_000)),
    ]);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    rows.push([
      String(i + 1),
      s.name,
      s.expect,
      r?.outcome ?? 'timeout',
      r && r.outcome === s.expect ? 'PASS' : 'FAIL',
      `${secs}s`,
      r?.summary ?? '',
    ]);
    console.log(`-> ${r?.outcome ?? 'timeout'} in ${secs}s: ${r?.summary ?? ''}`);
  }
  rl.close();
  caller.stop();

  const head = ['#', 'scenario', 'expected', 'got', 'result', 'time', 'summary'];
  const widths = head.map((h, c) => Math.max(h.length, ...rows.map((row) => row[c]!.length)));
  const line = (cells: string[]) => cells.map((cell, c) => cell.padEnd(widths[c]!)).join('  ');
  console.log(`\n${line(head)}\n${widths.map((w) => '-'.repeat(w)).join('  ')}`);
  for (const row of rows) console.log(line(row));
  rt.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
