/**
 * pnpm p1:edge
 * Runs every Phase 4 edge-case scenario with the fakes and prints a pass/fail table, then two
 * chaos runs: SIGKILL the engine during DELIBERATING and during BOOKING, restart against the same
 * SQLite file, and confirm the plan resumes to BOOKED.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FakeBubbles, FakeCaller, FakeDoers, FakeMessaging } from '@bubbleworks/shared/fakes';
import { loadConfig } from '../src/config.js';
import { bookings } from '../src/db/schema.js';
import { BubbleworksEngine } from '../src/engine/plan-engine.js';
import { createRuntime } from '../src/runtime.js';

const CHAT = 'crew:group_demo';
const DEADLINES = { poll_ms: 10_000, private_ask_ms: 5_000, veto_window_ms: 3_000, call_ms: 8_000 };
type Outcome =
  | 'booked'
  | 'booked_backup'
  | 'declined'
  | 'no_answer'
  | 'needs_human'
  | 'modified'
  | 'cancelled'
  | 'failed';

interface Row {
  scenario: string;
  pass: boolean;
  detail: string;
}

function harness(scripted: Outcome[] = []) {
  let clock = Date.parse('2026-10-10T21:00:00.000Z');
  const now = () => new Date(clock);
  const rt = createRuntime(loadConfig({ NODE_ENV: 'test', SEED_ON_BOOT: 'true' }), {
    dbPath: ':memory:',
    seed: true,
    timers: { deadlines: DEADLINES, now: () => clock },
  });
  const messaging = new FakeMessaging({ print: false });
  const ref: { e: BubbleworksEngine | null } = { e: null };
  const caller = new FakeCaller((r) => ref.e!.handleCallResult(r), {
    delayMs: 1,
    scriptedOutcomes: scripted,
  });
  const engine = new BubbleworksEngine({
    runtime: rt,
    bubbles: new FakeBubbles(),
    messaging,
    caller,
    doers: new FakeDoers(),
    now,
  });
  ref.e = engine;
  const at = () => now().toISOString();
  const advance = async (ms: number) => {
    clock += ms;
    await rt.timers.tick();
  };
  const settle = () => new Promise((r) => setTimeout(r, 15));
  const toLocked = async () => {
    const { planId } = await engine.handleIntent({
      chatId: CHAT,
      userId: 'user_ava',
      messageId: 'm1',
      text: 'dinner?',
      at: at(),
    });
    for (const u of ['user_ben', 'user_chloe', 'user_dev'])
      await engine.handleHeadcount({ planId: planId!, userId: u, in: true, at: at() });
    await engine.handleHeadcount({ planId: planId!, userId: 'user_eli', in: false, at: at() });
    if (rt.plans.get(planId!)?.state === 'GATHERING') await advance(DEADLINES.poll_ms + 1);
    return planId!;
  };
  const toBooked = async () => {
    const planId = await toLocked();
    await advance(DEADLINES.veto_window_ms + 1);
    await settle();
    return planId;
  };
  const close = () => {
    caller.dispose();
    rt.close();
  };
  return { rt, engine, caller, messaging, at, advance, settle, toLocked, toBooked, close };
}

async function scenario(name: string, run: () => Promise<string | null>): Promise<Row> {
  try {
    const problem = await run();
    return { scenario: name, pass: problem === null, detail: problem ?? 'ok' };
  } catch (err) {
    return { scenario: name, pass: false, detail: (err as Error).message };
  }
}

async function tableScenarios(): Promise<Row[]> {
  const rows: Row[] = [];

  rows.push(
    await scenario('dropout before booking -> rerun', async () => {
      const h = harness();
      const planId = await h.toLocked();
      await h.engine.handleHeadcount({ planId, userId: 'user_dev', in: false, at: h.at() });
      const p = h.rt.plans.get(planId)!;
      h.close();
      return p.state === 'LOCKED' && h.rt.plans ? null : `state ${p.state}`;
    }),
  );

  rows.push(
    await scenario('dropout after booking -> modify + split', async () => {
      const h = harness(['booked', 'modified']);
      const planId = await h.toBooked();
      await h.engine.handleHeadcount({ planId, userId: 'user_dev', in: false, at: h.at() });
      await h.settle();
      const b = h.rt.db.select().from(bookings).all()[0]!;
      const kinds = h.caller.calls.map((c) => c.kind).join(',');
      h.close();
      return b.partySize === 3 && kinds === 'book,modify'
        ? null
        : `party ${b.partySize}, calls ${kinds}`;
    }),
  );

  rows.push(
    await scenario('late joiner before lock -> rerun', async () => {
      const h = harness();
      const { planId } = await h.engine.handleIntent({
        chatId: CHAT,
        userId: 'user_ava',
        messageId: 'm1',
        text: 'dinner?',
        at: h.at(),
      });
      for (const u of ['user_ben', 'user_chloe'])
        await h.engine.handleHeadcount({ planId: planId!, userId: u, in: true, at: h.at() });
      for (const u of ['user_dev', 'user_eli'])
        await h.engine.handleHeadcount({ planId: planId!, userId: u, in: false, at: h.at() });
      if (h.rt.plans.get(planId!)?.state === 'GATHERING') await h.advance(DEADLINES.poll_ms + 1);
      await h.engine.handleHeadcount({ planId: planId!, userId: 'user_dev', in: true, at: h.at() });
      const n = h.rt.plans.inCount(planId!);
      const st = h.rt.plans.get(planId!)!.state;
      h.close();
      return n === 4 && st === 'LOCKED' ? null : `in ${n}, state ${st}`;
    }),
  );

  rows.push(
    await scenario('late joiner after booking -> modify for a seat', async () => {
      const h = harness(['booked', 'modified']);
      const planId = await h.toBooked();
      await h.engine.handleHeadcount({ planId, userId: 'user_eli', in: true, at: h.at() });
      await h.settle();
      const b = h.rt.db.select().from(bookings).all()[0]!;
      h.close();
      return b.partySize === 5 ? null : `party ${b.partySize}`;
    }),
  );

  rows.push(
    await scenario('fewer than two in -> close', async () => {
      const h = harness();
      const { planId } = await h.engine.handleIntent({
        chatId: CHAT,
        userId: 'user_ava',
        messageId: 'm1',
        text: 'dinner?',
        at: h.at(),
      });
      for (const u of ['user_ben', 'user_chloe', 'user_dev', 'user_eli'])
        await h.engine.handleHeadcount({ planId: planId!, userId: u, in: false, at: h.at() });
      const st = h.rt.plans.get(planId!)!.state;
      h.close();
      return st === 'CLOSED' ? null : `state ${st}`;
    }),
  );

  rows.push(
    await scenario('plan change "actually tomorrow" -> cancel booking, restart', async () => {
      const h = harness(['booked', 'cancelled']);
      const planId = await h.toBooked();
      const r = await h.engine.handleIntent({
        chatId: CHAT,
        userId: 'user_ava',
        messageId: 'm2',
        text: 'actually dinner tomorrow instead',
        at: h.at(),
      });
      const old = h.rt.plans.get(planId)!.state;
      const kinds = h.caller.calls.map((c) => c.kind).join(',');
      h.close();
      return old === 'CANCELLED' && r.created && kinds.includes('cancel')
        ? null
        : `old ${old}, created ${r.created}, calls ${kinds}`;
    }),
  );

  rows.push(
    await scenario('two plans in one chat -> scoped by plan id', async () => {
      const h = harness();
      const a = await h.engine.handleIntent({
        chatId: CHAT,
        userId: 'user_ava',
        messageId: 'm1',
        text: 'dinner tonight?',
        at: h.at(),
      });
      const b = await h.engine.handleIntent({
        chatId: CHAT,
        userId: 'user_ben',
        messageId: 'm2',
        text: 'brunch tomorrow?',
        at: h.at(),
      });
      await h.engine.handleHeadcount({
        planId: b.planId!,
        userId: 'user_chloe',
        in: true,
        at: h.at(),
      });
      const aC = h.rt.plans.members(a.planId!).find((m) => m.userId === 'user_chloe')?.status;
      const n = h.rt.plans.findActiveForChat(CHAT).length;
      h.close();
      return n === 2 && aC === 'invited' ? null : `active ${n}, chloe in plan A ${aC}`;
    }),
  );

  rows.push(
    await scenario('deposit request -> needs_human, one person decides', async () => {
      const h = harness(['needs_human', 'booked']);
      const planId = await h.toLocked();
      await h.advance(DEADLINES.veto_window_ms + 1);
      await h.settle();
      const pending = h.engine.pendingAskFor('user_ava');
      const st = h.rt.plans.get(planId)!.state;
      let after = '';
      if (pending) {
        await h.engine.handleAskAnswer({
          askId: pending.askId,
          userId: 'user_ava',
          answer: 'no',
          rawText: 'no',
          at: h.at(),
        });
        after = h.rt.plans.get(planId)!.state;
      }
      h.close();
      return st === 'BOOKING' && pending && after === 'LOCKED'
        ? null
        : `state ${st}, ask ${Boolean(pending)}, after ${after}`;
    }),
  );

  rows.push(
    await scenario('member leaves the crew -> dropped, rerun', async () => {
      const h = harness();
      const planId = await h.toLocked();
      await h.engine.handleMemberChange({
        chatId: CHAT,
        userId: 'user_ben',
        change: 'left',
        at: h.at(),
      });
      const st = h.rt.plans.members(planId).find((m) => m.userId === 'user_ben')?.status;
      const n = h.rt.plans.inCount(planId);
      h.close();
      return st === 'dropped' && n === 3 ? null : `status ${st}, in ${n}`;
    }),
  );

  rows.push(
    await scenario('server restart mid-call -> timeout reschedules, rerun', async () => {
      const h = harness(['booked']);
      const planId = await h.toLocked();
      await h.advance(DEADLINES.veto_window_ms + 1);
      h.caller.dispose();
      h.rt.timers.cancel(planId, 'call_timeout');
      await h.engine.kick(planId);
      const re = h.rt.timers
        .pending(planId)
        .map((t) => t.kind)
        .join(',');
      await h.advance(DEADLINES.call_ms + 1);
      const st = h.rt.plans.get(planId)!.state;
      h.close();
      return re === 'call_timeout' && ['LOCKED', 'DELIBERATING', 'DEADLOCK'].includes(st)
        ? null
        : `rescheduled ${re}, state ${st}`;
    }),
  );

  return rows;
}

// -- chaos: kill the worker in a given state, restart, expect BOOKED ---------------------------

function runWorker(
  dbPath: string,
  args: string[],
  onLine: (line: string, kill: () => void) => void,
): Promise<number | null> {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', resolve(import.meta.dirname, 'edge-worker.ts'), '--db', dbPath, ...args],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env, NODE_ENV: 'test' },
      },
    );
    let buf = '';
    child.stdout.on('data', (c: Buffer) => {
      buf += c.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        console.log(`    ${line}`);
        onLine(line, () => child.kill('SIGKILL'));
      }
    });
    child.on('error', fail);
    child.on('exit', (code, signal) => done(signal === 'SIGKILL' ? -9 : code));
  });
}

async function chaos(killState: 'DELIBERATING' | 'BOOKING'): Promise<Row> {
  const dir = mkdtempSync(join(tmpdir(), 'bubbleworks-chaos-'));
  const db = join(dir, 'chaos.db');
  try {
    const first = await runWorker(
      db,
      ['--stage', 'fresh', '--kill-at', killState],
      (line, kill) => {
        if (line.startsWith(`AT ${killState}`)) kill();
      },
    );
    if (first !== -9)
      return {
        scenario: `chaos: kill during ${killState}`,
        pass: false,
        detail: `worker exited ${first} before the kill point`,
      };
    let finalState = '';
    const second = await runWorker(db, ['--stage', 'resume'], (line) => {
      const m = /^FINAL (\w+)/.exec(line);
      if (m) finalState = m[1]!;
    });
    return {
      scenario: `chaos: kill during ${killState}, restart`,
      pass: second === 0 && finalState === 'BOOKED',
      detail: `resumed to ${finalState || 'unknown'} (exit ${second})`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const rows = await tableScenarios();
  console.log('\nchaos runs:');
  rows.push(await chaos('DELIBERATING'));
  rows.push(await chaos('BOOKING'));

  console.log('\n' + 'scenario'.padEnd(58) + 'result   detail');
  console.log('-'.repeat(100));
  for (const r of rows)
    console.log(`${r.scenario.padEnd(58)}${r.pass ? 'PASS' : 'FAIL'}     ${r.detail}`);
  const failed = rows.filter((r) => !r.pass).length;
  console.log(`\n${rows.length - failed}/${rows.length} passed`);
  console.log(
    'phone check (dropout after booking on the real line): pending P4 caller + LINE LOCK',
  );
  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('EDGE FAILED', err);
  process.exit(1);
});
