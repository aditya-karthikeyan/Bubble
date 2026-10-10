import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanEvent, PlanState } from '@bubbleworks/shared';
import type { Runtime } from '../runtime.js';
import { INTENT, testRuntime } from '../test-helpers.js';

let rt: Runtime;
beforeEach(() => {
  rt = testRuntime();
});
afterEach(() => rt.close());

const at = '2026-10-10T19:00:00.000Z';
const ev = (planId: string, to: PlanState = 'DETECTED'): PlanEvent => ({
  type: 'plan_state_changed',
  planId,
  at,
  from: 'IDLE',
  to,
});

describe('SqliteEventBus', () => {
  it('assigns per-plan seq and replays in order', async () => {
    const a = await rt.bus.publish(ev('plan_a'));
    const b = await rt.bus.publish(ev('plan_b'));
    const a2 = await rt.bus.publish(ev('plan_a', 'GATHERING'));
    expect([a.seq, b.seq, a2.seq]).toEqual([1, 1, 2]);
    expect((await rt.bus.replay('plan_a')).map((e) => e.seq)).toEqual([1, 2]);
    expect(await rt.bus.replay('plan_zzz')).toEqual([]);
  });

  it('validates events at publish', async () => {
    await expect(
      rt.bus.publish({
        type: 'bubble_joined',
        planId: 'p',
        at,
        bubble: { userId: 'u', displayName: 'U', status: 'vegetarian' },
      } as unknown as PlanEvent),
    ).rejects.toThrow();
  });

  it('notifies plan and wildcard subscribers, surviving a throwing handler', async () => {
    const got: string[] = [];
    rt.bus.subscribe('plan_a', (e) => void got.push(`a:${e.seq}`));
    const off = rt.bus.subscribe('*', (e) => void got.push(`*:${e.planId}`));
    rt.bus.subscribe('*', () => {
      throw new Error('boom');
    });
    await rt.bus.publish(ev('plan_a'));
    await rt.bus.publish(ev('plan_b'));
    off();
    await rt.bus.publish(ev('plan_b'));
    expect(got).toEqual(['a:1', '*:plan_a', '*:plan_b']);
  });

  it('broadcasts to the plan page token and replays by token until expiry', async () => {
    const broadcast = vi.fn();
    rt.bus.setBroadcaster(broadcast);
    const plan = rt.plans.create({
      groupId: 'group_demo',
      chatId: 'chat_demo',
      intent: INTENT,
      createdByUserId: 'user_ava',
    });
    await rt.plans.transition(plan.id, 'DETECTED');
    expect(broadcast).toHaveBeenCalledWith(
      plan.pageToken,
      expect.objectContaining({ to: 'DETECTED', seq: 1 }),
    );
    expect(await rt.bus.replayForToken(plan.pageToken)).toHaveLength(1);
    expect(await rt.bus.replayForToken('unknown-token-123')).toBeNull();

    await rt.plans.transition(plan.id, 'CANCELLED');
    expect(await rt.bus.replayForToken(plan.pageToken)).toHaveLength(2);
    const later = new Date(Date.now() + 3 * 60 * 60_000);
    vi.useFakeTimers({ now: later });
    try {
      const rt2 = testRuntime();
      rt2.close();
      // Same bus, clock moved past expiry.
      const { SqliteEventBus } = await import('./bus.js');
      const bus = new SqliteEventBus(rt.db, { now: () => later });
      expect(await bus.replayForToken(plan.pageToken)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
