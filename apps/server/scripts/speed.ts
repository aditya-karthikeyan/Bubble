/**
 * pnpm p1:speed [runs]
 * Runs the basic flow N times with the fakes and reports the p50 and p95 of every timing mark
 * (ms since the intent message) plus the solver's own time. Real-line numbers come from P2's
 * timing logs.
 */
import { FakeBubbles, FakeCaller, FakeDoers, FakeMessaging } from '@bubbleworks/shared/fakes';
import { loadConfig } from '../src/config.js';
import { BubbleworksEngine } from '../src/engine/plan-engine.js';
import type { Logger } from '../src/events/bus.js';
import { createRuntime } from '../src/runtime.js';

const runs = Number(process.argv.slice(2).find((a) => a !== '--') ?? 10);
const CHAT = 'crew:group_demo';
const DEADLINES = { poll_ms: 60_000, private_ask_ms: 30_000, veto_window_ms: 0, call_ms: 60_000 };

async function one(): Promise<Record<string, number>> {
  const marks: Record<string, number> = {};
  const log: Logger = {
    info: (o, m) => {
      if (m === 'timing') marks[String(o['mark'])] = Number(o['ms']);
    },
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
  const rt = createRuntime(loadConfig({ NODE_ENV: 'test', SEED_ON_BOOT: 'true' }), {
    dbPath: ':memory:',
    seed: true,
    log,
    timers: { deadlines: DEADLINES, tickMs: 10 },
  });
  const ref: { e: BubbleworksEngine | null } = { e: null };
  const caller = new FakeCaller((r) => ref.e!.handleCallResult(r), { delayMs: 5 });
  const engine = new BubbleworksEngine({
    now: () => new Date('2026-10-10T21:00:00.000Z'),
    runtime: rt,
    bubbles: new FakeBubbles(),
    messaging: new FakeMessaging({ print: false }),
    caller,
    doers: new FakeDoers(),
    log,
  });
  ref.e = engine;
  rt.timers.start();
  const now = () => new Date().toISOString();
  const t0 = performance.now();
  const { planId } = await engine.handleIntent({
    chatId: CHAT,
    userId: 'user_ava',
    messageId: 'm1',
    text: 'dinner tonight?',
    at: now(),
  });
  for (const u of ['user_ben', 'user_chloe', 'user_dev'])
    await engine.handleHeadcount({ planId: planId!, userId: u, in: true, at: now() });
  await engine.handleHeadcount({ planId: planId!, userId: 'user_eli', in: false, at: now() });
  const poll = rt.timers.pending(planId!).find((t) => t.kind === 'poll_deadline');
  const spec = poll?.payload as
    | {
        pollId?: string;
        options?: Array<{ key: string }>;
        stylePollId?: string;
        styleOptions?: Array<{ key: string }>;
      }
    | undefined;
  for (const [id, opts] of [
    [spec?.stylePollId, spec?.styleOptions],
    [spec?.pollId, spec?.options],
  ] as const) {
    if (!id || !opts?.length) continue;
    for (const u of ['user_ava', 'user_ben', 'user_chloe', 'user_dev'])
      await engine.handleVote({
        planId: planId!,
        pollId: id,
        userId: u,
        choices: [opts[0]!.key],
        at: now(),
      });
  }
  const tLockDone = performance.now();
  await new Promise<void>((resolve) => {
    const i = setInterval(() => {
      if (rt.plans.get(planId!)?.state === 'BOOKED') {
        clearInterval(i);
        resolve();
      }
    }, 5);
    setTimeout(() => {
      clearInterval(i);
      resolve();
    }, 10_000);
  });
  marks['intent_to_lock_wall'] = Math.round(tLockDone - t0);
  marks['intent_to_booked_wall'] = Math.round(performance.now() - t0);
  caller.dispose();
  rt.close();
  return marks;
}

function pct(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

async function main(): Promise<void> {
  const all: Record<string, number>[] = [];
  for (let i = 0; i < runs; i += 1) all.push(await one());
  const keys = [
    't_detect',
    't_poll_posted',
    't_lock',
    't_dial',
    't_booked',
    'intent_to_lock_wall',
    'intent_to_booked_wall',
  ];
  console.log(`speed report over ${runs} simulated runs (ms since intent; fakes, veto window 0)\n`);
  console.log('mark'.padEnd(24) + 'p50'.padStart(8) + 'p95'.padStart(8) + '   target');
  const targets: Record<string, string> = {
    t_poll_posted: '5000',
    t_dial: 'lock+2000',
    t_booked: 'lock+90000',
  };
  for (const k of keys) {
    const vals = all.map((m) => m[k]).filter((v): v is number => typeof v === 'number');
    if (!vals.length) continue;
    console.log(
      k.padEnd(24) +
        String(pct(vals, 50)).padStart(8) +
        String(pct(vals, 95)).padStart(8) +
        '   ' +
        (targets[k] ?? ''),
    );
  }
  const slow = keys
    .filter((k) => all.some((m) => typeof m[k] === 'number'))
    .sort(
      (a, b) =>
        pct(
          all.map((m) => m[b] ?? 0),
          50,
        ) -
        pct(
          all.map((m) => m[a] ?? 0),
          50,
        ),
    )[0];
  console.log(
    `\nslowest step by p50: ${slow}. Real-line numbers come from the timing logs.`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
