/**
 * pnpm sim <basic|tie|deadlock|deadlock-decline|absent|veto>
 * Drives the real engine with every fake, short deadlines, and real time. Prints a timeline:
 * state transitions, page events, outbound messages, and the timing marks
 * (t_detect, t_poll_posted, t_lock, t_dial, t_booked) relative to the intent.
 * SIM_EVENTS_OUT=<path> also writes every page event as JSON (P4's live page replay fixtures).
 */
import { writeFileSync } from 'node:fs';
import type { PlanEvent } from '@bubbleworks/shared';
import {
  FakeBubbles,
  FakeCaller,
  FakeDoers,
  FakeMessaging,
  PERSONA_FACTS,
} from '@bubbleworks/shared/fakes';
import { loadConfig } from '../src/config.js';
import { BubbleworksEngine } from '../src/engine/plan-engine.js';
import type { Logger } from '../src/events/bus.js';
import { createRuntime } from '../src/runtime.js';

const scenario = process.argv.slice(2).find((a) => a !== '--') ?? 'basic';
const CHAT = 'crew:group_demo';
const DEADLINES = { poll_ms: 1_500, private_ask_ms: 800, veto_window_ms: 800, call_ms: 3_000 };
function inUsersFor(scn: string): string[] {
  return scn === 'absent'
    ? ['user_ben', 'user_chloe']
    : scn.startsWith('deadlock')
      ? ['user_chloe']
      : ['user_ben', 'user_chloe', 'user_dev'];
}
const t0 = Date.now();
const stamp = () => `+${String(Date.now() - t0).padStart(5, ' ')}ms`;
const say = (line: string) => console.log(`${stamp()}  ${line}`);
const marks: Record<string, number> = {};

const log: Logger = {
  info: (o, msg) => {
    if (msg === 'timing') {
      marks[String(o['mark'])] = Number(o['ms']);
      say(`MARK ${o['mark']} = ${o['ms']} ms`);
    } else if (msg === 'plan transition')
      say(`STATE ${o['from']} -> ${o['to']}  (${o['reason'] ?? ''})`);
    else if (msg === 'question policy')
      say(
        `POLICY feasible=${o['feasible']} askCuisine=${o['askCuisine']} (${o['reason']}) start=${o['startMinutes']}`,
      );
    else if (msg === 'poll decided') say(`POLL decided: ${o['leader']}`);
  },
  warn: (o, msg) => say(`WARN ${msg ?? ''} ${JSON.stringify(o)}`),
  error: (o, msg) => say(`ERROR ${msg ?? ''} ${JSON.stringify(o)}`),
  debug: () => undefined,
};

async function main(): Promise<void> {
  const deadlock = scenario.startsWith('deadlock');
  const facts = deadlock
    ? PERSONA_FACTS.map((f) => (f.id === 'fact_chloe_budget' ? { ...f, value: '10' } : f))
    : PERSONA_FACTS;
  const bubbles = new FakeBubbles(undefined, facts);
  if (scenario === 'absent') bubbles.setPresence('user_eli', 'focus');
  const config = loadConfig({ NODE_ENV: 'test', SEED_ON_BOOT: 'true', DEMO_MODE: 'true' });
  const rt = createRuntime(config, {
    dbPath: ':memory:',
    seed: true,
    log,
    timers: { deadlines: DEADLINES, tickMs: 50 },
  });
  const messaging = new FakeMessaging({ print: false, log: (line) => say(`MSG ${line}`) });
  const doers = new FakeDoers();
  const ref: { engine: BubbleworksEngine | null } = { engine: null };
  const caller = new FakeCaller((r) => ref.engine!.handleCallResult(r), {
    delayMs: 600,
    log: (l) => say(`CALL ${l}`),
  });
  const engine = new BubbleworksEngine({
    now: () => new Date('2026-10-10T21:00:00.000Z'),
    runtime: rt,
    bubbles,
    messaging,
    caller,
    doers,
    webPublicUrl: 'https://bubbleworks-eosin.vercel.app',
    log,
  });
  ref.engine = engine;
  const recorded: PlanEvent[] = [];
  rt.bus.subscribe('*', (e: PlanEvent) => {
    recorded.push(e);
    const extra =
      e.type === 'private_ask_sent'
        ? ` ${e.askId}`
        : e.type === 'private_ask_resolved'
          ? ` ${e.askId} ${e.outcome}`
          : e.type === 'round_complete'
            ? ` round ${e.round} leader=${e.leaderVenueId} bubbles=${e.bubbles.map((b) => `${b.displayName}:${b.status}`).join(',')}`
            : e.type === 'candidate_eliminated'
              ? ` ${e.venueId} (${e.reason})`
              : e.type === 'plan_locked'
                ? ` ${e.venue.name} @ ${e.startAt} backup=${e.backup?.name ?? 'none'} party=${e.partySize}`
                : e.type === 'doer_status'
                  ? ` ${e.doer} ${e.state} ${e.detail ?? ''}`
                  : e.type === 'bubble_joined'
                    ? ` ${e.bubble.displayName} (${e.bubble.status})`
                    : e.type === 'candidate_added'
                      ? ` ${e.venue.name}`
                      : '';
    say(`  event #${e.seq} ${e.type}${extra}`);
  });
  rt.timers.start();

  const now = () => new Date().toISOString();
  say(`SCENARIO ${scenario}`);
  const r = await engine.handleIntent({
    chatId: CHAT,
    userId: 'user_ava',
    messageId: 'm1',
    text: scenario === 'absent' ? 'pizza tonight?' : 'dinner tonight?',
    at: now(),
  });
  const planId = r.planId!;
  const sentPolls = messaging.sent.filter((s) => s.kind === 'poll');
  const cuisinePollSent = sentPolls.find(
    (s) => 'input' in s && !s.input.options.some((o) => o.key === 'sit_down'),
  );
  const stylePollSent = sentPolls.find(
    (s) => 'input' in s && s.input.options.some((o) => o.key === 'sit_down'),
  );
  const pollInput = cuisinePollSent && 'input' in cuisinePollSent ? cuisinePollSent.input : null;
  if (stylePollSent && 'input' in stylePollSent && scenario !== 'absent') {
    for (const u of ['user_ava', ...inUsersFor(scenario)]) {
      await engine.handleVote({
        planId,
        pollId: stylePollSent.input.pollId,
        userId: u,
        choices: ['sit_down'],
        at: now(),
      });
    }
  }

  const inUsers =
    scenario === 'absent'
      ? ['user_ben', 'user_chloe']
      : deadlock
        ? ['user_chloe']
        : ['user_ben', 'user_chloe', 'user_dev'];
  const outUsers =
    scenario === 'absent'
      ? ['user_dev']
      : deadlock
        ? ['user_ben', 'user_dev', 'user_eli']
        : ['user_eli'];
  for (const u of inUsers) await engine.handleHeadcount({ planId, userId: u, in: true, at: now() });
  for (const u of outUsers)
    await engine.handleHeadcount({ planId, userId: u, in: false, at: now() });

  if (pollInput && scenario !== 'absent') {
    const keys = pollInput.options.map((o) => o.key);
    const votes: Record<string, string> =
      scenario === 'tie'
        ? {
            user_ava: keys[0]!,
            user_ben: keys[1] ?? keys[0]!,
            user_chloe: keys[0]!,
            user_dev: keys[1] ?? keys[0]!,
          }
        : {
            user_ava: keys[0]!,
            user_ben: keys[0]!,
            user_chloe: keys[0]!,
            user_dev: keys[1] ?? keys[0]!,
          };
    for (const [u, choice] of Object.entries(votes)) {
      if (!['user_ava', ...inUsers].includes(u)) continue;
      await engine.handleVote({
        planId,
        pollId: pollInput.pollId,
        userId: u,
        choices: [choice],
        at: now(),
      });
    }
  }

  const done = new Promise<void>((resolve) => {
    const check = setInterval(() => {
      const p = rt.plans.get(planId);
      if (!p) return;
      if (deadlock && p.state === 'DEADLOCK' && !marks['ask_answered']) {
        const who = engine.pendingAskFor('user_chloe')
          ? 'user_chloe'
          : engine.pendingAskFor('user_ava')
            ? 'user_ava'
            : null;
        const pending = who ? engine.pendingAskFor(who) : null;
        if (who && pending) {
          marks['ask_answered'] = 1;
          const answer = scenario === 'deadlock-decline' ? 'no' : 'yes';
          say(`ANSWER ${who} says ${answer}`);
          void engine
            .handleAskAnswer({
              askId: pending.askId,
              userId: who,
              answer,
              rawText: answer,
              at: now(),
            })
            .then(async () => {
              if (scenario !== 'deadlock-decline') return;
              const other = who === 'user_chloe' ? 'user_ava' : 'user_chloe';
              const second = engine.pendingAskFor(other);
              if (second) {
                say(`ANSWER ${other} says no`);
                await engine.handleAskAnswer({
                  askId: second.askId,
                  userId: other,
                  answer: 'no',
                  rawText: 'no',
                  at: now(),
                });
              }
            });
        }
        return;
      }
      if (scenario === 'veto' && p.state === 'LOCKED' && !marks['veto_sent']) {
        marks['veto_sent'] = 1;
        void engine.handleCommand({
          chatId: CHAT,
          userId: 'user_ben',
          command: 'veto',
          messageId: 'm9',
          at: now(),
        });
        return;
      }
      if (['BOOKED', 'CLOSED', 'FAILED', 'CANCELLED'].includes(p.state)) {
        clearInterval(check);
        resolve();
      }
    }, 50);
    setTimeout(() => {
      clearInterval(check);
      resolve();
    }, 20_000);
  });
  await done;
  await new Promise((r2) => setTimeout(r2, 100));

  const plan = rt.plans.mustGet(planId);
  say(`FINAL ${plan.state} venue=${plan.chosenVenueId} backup=${plan.backupVenueId}`);
  console.log('\nTiming marks (ms since intent):');
  for (const m of ['t_detect', 't_poll_posted', 't_lock', 't_dial', 't_booked'])
    console.log(`  ${m.padEnd(14)} ${marks[m] ?? '-'}`);
  console.log(
    `Group messages: ${messaging.sent.filter((s) => s.kind === 'group_text').length}, doers: ${doers.calls.map((c) => c.doer).join(',') || 'none'}`,
  );
  if (process.env['SIM_EVENTS_OUT']) {
    writeFileSync(process.env['SIM_EVENTS_OUT'], `${JSON.stringify(recorded, null, 2)}\n`);
  }
  caller.dispose();
  rt.close();
  const ok =
    scenario === 'deadlock-decline'
      ? ['CLOSED', 'BOOKED'].includes(plan.state)
      : plan.state === 'BOOKED';
  console.log(ok ? `SIM ${scenario} OK` : `SIM ${scenario} UNEXPECTED STATE ${plan.state}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
