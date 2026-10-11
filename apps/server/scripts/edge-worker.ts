/**
 * Chaos worker for pnpm p1:edge. Stage fresh: run a plan with real timers until the plan reaches
 * --kill-at, print "AT <state>" and idle so the parent can SIGKILL. Stage resume: open the same
 * database, kick the plan, and print FINAL <state> once it settles.
 */
import { parseArgs } from 'node:util';
import { FakeBubbles, FakeCaller, FakeDoers, FakeMessaging } from '@bubbleworks/shared/fakes';
import { loadConfig } from '../src/config.js';
import { BubbleworksEngine } from '../src/engine/plan-engine.js';
import type { Logger } from '../src/events/bus.js';
import { createRuntime } from '../src/runtime.js';

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    stage: { type: 'string', default: 'fresh' },
    'kill-at': { type: 'string' },
  },
});
if (!values.db) throw new Error('--db required');
const DEADLINES = { poll_ms: 1_200, private_ask_ms: 800, veto_window_ms: 1_500, call_ms: 2_500 };
const CHAT = 'crew:group_demo';
const say = (l: string) => console.log(l);
const log: Logger = {
  info: (o, m) => {
    if (m === 'plan transition') say(`STATE ${o['from']} -> ${o['to']}`);
    if (m === 'timer fired') say(`TIMER ${o['kind']} late ${o['lateMs']} ms`);
  },
  warn: (o, m) => say(`WARN ${m ?? ''} ${JSON.stringify(o)}`),
  error: (o, m) => say(`ERROR ${m ?? ''} ${JSON.stringify(o)}`),
  debug: () => undefined,
};

async function main(): Promise<void> {
  const config = loadConfig({ NODE_ENV: 'test', SEED_ON_BOOT: 'false' });
  const rt = createRuntime(config, {
    dbPath: values.db!,
    seed: values.stage === 'fresh',
    log,
    timers: { deadlines: DEADLINES, tickMs: 50 },
  });
  const messaging = new FakeMessaging({ print: false });
  const ref: { e: BubbleworksEngine | null } = { e: null };
  // The call takes longer than the kill window so a BOOKING kill lands mid-call.
  const caller = new FakeCaller((r) => ref.e!.handleCallResult(r), { delayMs: 1_500 });
  const engine = new BubbleworksEngine({
    now: () => new Date('2026-10-10T21:00:00.000Z'),
    runtime: rt,
    bubbles: new FakeBubbles(),
    messaging,
    caller,
    doers: new FakeDoers(),
    log,
  });
  ref.e = engine;
  rt.timers.start();

  // Kill from inside the state-change event so the kill lands mid-step, before the next
  // transition is persisted: DELIBERATING lasts milliseconds, a polling watcher would miss it.
  const killAt = values['kill-at'];
  if (killAt) {
    rt.bus.subscribe('*', (e) => {
      if (e.type === 'plan_state_changed' && e.to === killAt) {
        say(`AT ${killAt}`);
        process.kill(process.pid, 'SIGKILL');
      }
    });
  }

  let planId: string;
  if (values.stage === 'fresh') {
    const now = () => new Date().toISOString();
    const r = await engine.handleIntent({
      chatId: CHAT,
      userId: 'user_ava',
      messageId: 'm1',
      text: 'dinner tonight?',
      at: now(),
    });
    planId = r.planId!;
    for (const u of ['user_ben', 'user_chloe', 'user_dev'])
      await engine.handleHeadcount({ planId, userId: u, in: true, at: now() });
    await engine.handleHeadcount({ planId, userId: 'user_eli', in: false, at: now() });
    // Leave the poll open so the deadline timer drives deliberation.
  } else {
    const active = rt.plans.findAllActive();
    planId = active[0]?.id ?? '';
    say(
      `RESUMED ${active.map((p) => `${p.id} ${p.state}`).join(', ')} pending timers: ${
        rt.timers
          .pending()
          .map((t) => t.kind)
          .join(',') || 'none'
      }`,
    );
    for (const p of active) await engine.kick(p.id);
  }

  const start = Date.now();
  const watch = setInterval(() => {
    const p = rt.plans.get(planId);
    if (!p) return;
    if (
      ['BOOKED', 'CLOSED', 'FAILED', 'CANCELLED'].includes(p.state) ||
      Date.now() - start > 20_000
    ) {
      clearInterval(watch);
      say(`FINAL ${p.state}`);
      caller.dispose();
      rt.close();
      process.exit(0);
    }
  }, 25);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
