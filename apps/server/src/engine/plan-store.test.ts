import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanEvent } from '@bubbleworks/shared';
import { DEMO_GROUP } from '@bubbleworks/shared/fakes';
import { audit } from '../db/schema.js';
import type { Runtime } from '../runtime.js';
import { INTENT, testRuntime } from '../test-helpers.js';
import { IllegalTransitionError } from './state-machine.js';

let rt: Runtime;
beforeEach(() => {
  rt = testRuntime();
});
afterEach(() => rt.close());

const create = () =>
  rt.plans.create({
    groupId: 'group_demo',
    chatId: DEMO_GROUP.chatId,
    intent: INTENT,
    createdByUserId: 'user_ava',
  });

describe('PlanStore', () => {
  it('creates a plan in IDLE with a page token and budget', () => {
    const plan = create();
    expect(plan.state).toBe('IDLE');
    expect(plan.pageToken).toHaveLength(22);
    expect(plan.messageBudget).toBe(8);
    expect(rt.plans.findByPageToken(plan.pageToken)?.id).toBe(plan.id);
  });

  it('persists transitions and publishes plan_state_changed with seq', async () => {
    const plan = create();
    const seen: PlanEvent[] = [];
    rt.bus.subscribe(plan.id, (e) => void seen.push(e));
    await rt.plans.transition(plan.id, 'DETECTED', { reason: 'intent' });
    const after = await rt.plans.transition(plan.id, 'GATHERING');
    expect(after.state).toBe('GATHERING');
    expect(rt.plans.get(plan.id)?.state).toBe('GATHERING');
    expect(seen.map((e) => [e.type, e.seq])).toEqual([
      ['plan_state_changed', 1],
      ['plan_state_changed', 2],
    ]);
    expect(seen[0]).toMatchObject({ from: 'IDLE', to: 'DETECTED', reason: 'intent' });
  });

  it('rejects illegal transitions, audits them, and leaves state alone', async () => {
    const plan = create();
    await expect(rt.plans.transition(plan.id, 'BOOKED')).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    expect(rt.plans.get(plan.id)?.state).toBe('IDLE');
    const rows = rt.db.select().from(audit).all();
    expect(rows.some((r) => r.action === 'illegal_transition')).toBe(true);
    expect(await rt.bus.replay(plan.id)).toEqual([]);
  });

  it("auditFor returns the plan's rows as kind, payload, createdAt in insertion order", async () => {
    const plan = create();
    const other = create();
    await rt.plans.transition(plan.id, 'DETECTED', { reason: 'intent' });
    const solverRun = {
      feasible: 2,
      infeasible: 1,
      byReason: { allergen: 1 },
      byMember: { user_ben: { allergen: 1 } },
    };
    rt.plans.audit(plan.id, 'solver_run', solverRun);
    rt.plans.audit(other.id, 'solver_run', { feasible: 0 });
    const rows = rt.plans.auditFor(plan.id);
    expect(rows.map((r) => r.kind)).toEqual(['plan_created', 'transition', 'solver_run']);
    expect(rows[2]).toEqual({
      kind: 'solver_run',
      payload: solverRun,
      createdAt: expect.any(String),
    });
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['createdAt', 'kind', 'payload']);
    expect(rt.plans.auditFor(other.id).map((r) => r.kind)).toEqual(['plan_created', 'solver_run']);
  });

  it('counts members in for the party-size guard', async () => {
    const plan = create();
    await rt.plans.transition(plan.id, 'DETECTED');
    await rt.plans.transition(plan.id, 'GATHERING');
    rt.plans.upsertMember(plan.id, 'user_ava', 'in');
    const r = await rt.plans.tryTransition(plan.id, 'DELIBERATING');
    expect(r.ok).toBe(false);
    rt.plans.upsertMember(plan.id, 'user_ben', 'represented', true);
    expect(rt.plans.inCount(plan.id)).toBe(2);
    await rt.plans.transition(plan.id, 'DELIBERATING');
    expect(
      rt.plans.members(plan.id).find((m) => m.userId === 'user_ben')?.representedByBubble,
    ).toBe(true);
  });

  it('PAUSED remembers and clears the resume state', async () => {
    const plan = create();
    await rt.plans.transition(plan.id, 'DETECTED');
    const paused = await rt.plans.transition(plan.id, 'PAUSED');
    expect(paused.resumeState).toBe('DETECTED');
    const back = await rt.plans.transition(plan.id, 'DETECTED');
    expect(back.resumeState).toBeNull();
  });

  it('terminal transitions stamp closedAt and the page token expiry', async () => {
    const plan = create();
    await rt.plans.transition(plan.id, 'DETECTED');
    const done = await rt.plans.transition(plan.id, 'CANCELLED');
    expect(done.closedAt).not.toBeNull();
    expect(Date.parse(done.pageTokenExpiresAt!) - Date.parse(done.closedAt!)).toBe(2 * 60 * 60_000);
    expect(rt.plans.findActiveForChat(DEMO_GROUP.chatId)).toEqual([]);
    expect(rt.plans.findAllActive()).toEqual([]);
  });

  it('spends the message budget per member', () => {
    const plan = create();
    let remaining = 0;
    for (let i = 0; i < 8; i += 1) remaining = rt.plans.spendMessage(plan.id, 'user_ava');
    expect(remaining).toBe(0);
    expect(rt.plans.spendMessage(plan.id, 'user_ava')).toBe(-1);
    expect(rt.plans.spendMessage(plan.id, 'user_ben')).toBe(7);
    expect(rt.plans.get(plan.id)?.messagesUsed).toBe(9);
    expect(rt.plans.members(plan.id).find((m) => m.userId === 'user_ava')?.messagesUsed).toBe(8);
  });
});
