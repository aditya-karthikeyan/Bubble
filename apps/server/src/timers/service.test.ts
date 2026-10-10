import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEADLINES, DEMO_DEADLINES } from '@bubbleworks/shared';
import { openDb, type DbHandle } from '../db/client.js';
import { TimerService, type FiredTimer } from './service.js';

let handle: DbHandle;
let clock: number;
const now = () => clock;

beforeEach(() => {
  handle = openDb(':memory:');
  clock = Date.parse('2026-10-10T19:00:00.000Z');
});
afterEach(() => handle.close());

describe('TimerService', () => {
  it('uses product deadlines, demo deadlines, or overrides', () => {
    expect(new TimerService(handle.db).deadlines.poll_ms).toBe(DEADLINES.poll_ms);
    expect(new TimerService(handle.db, { demoMode: true }).deadlines.poll_ms).toBe(
      DEMO_DEADLINES.poll_ms,
    );
    expect(new TimerService(handle.db, { demoMode: true }).deadlines.veto_window_ms).toBe(15_000);
    expect(new TimerService(handle.db, { deadlines: { poll_ms: 5 } }).deadlines.poll_ms).toBe(5);
  });

  it('schedules a deadline-backed kind idempotently and fires it once when due', async () => {
    const svc = new TimerService(handle.db, { demoMode: true, now });
    const fired: FiredTimer[] = [];
    svc.on('poll_deadline', (t) => void fired.push(t));
    const first = svc.schedule({
      planId: 'p1',
      kind: 'poll_deadline',
      payload: { pollId: 'poll_1' },
    });
    const again = svc.schedule({
      planId: 'p1',
      kind: 'poll_deadline',
      payload: { pollId: 'other' },
    });
    expect(again).toEqual(first);
    expect(first.fireAt).toBe(clock + DEMO_DEADLINES.poll_ms);
    expect(svc.pending('p1')).toHaveLength(1);

    expect(await svc.tick()).toEqual([]);
    clock += DEMO_DEADLINES.poll_ms - 1;
    expect(await svc.tick()).toEqual([]);
    clock += 1;
    const out = await svc.tick();
    expect(out).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      planId: 'p1',
      kind: 'poll_deadline',
      payload: { pollId: 'poll_1' },
      lateMs: 0,
    });
    expect(await svc.tick()).toEqual([]);
    expect(svc.pending('p1')).toEqual([]);
    expect(svc.get(first.id)?.firedAt).not.toBeNull();
  });

  it('replace moves an unfired timer; cancel removes by kind or plan', () => {
    const svc = new TimerService(handle.db, { now });
    svc.schedule({ planId: 'p1', kind: 'veto_window', delayMs: 100 });
    const moved = svc.schedule({ planId: 'p1', kind: 'veto_window', delayMs: 500, replace: true });
    expect(moved.fireAt).toBe(clock + 500);
    svc.schedule({ planId: 'p1', kind: 'ask_timeout', id: 'p1:ask:a', delayMs: 10 });
    svc.schedule({ planId: 'p1', kind: 'ask_timeout', id: 'p1:ask:b', delayMs: 10 });
    expect(svc.pending('p1')).toHaveLength(3);
    expect(svc.cancel('p1', 'ask_timeout')).toBe(2);
    expect(svc.cancel('p1')).toBe(1);
    expect(svc.pending()).toEqual([]);
  });

  it('survives a restart: a second service on the same database fires the pending timer, late', async () => {
    const a = new TimerService(handle.db, { now });
    a.schedule({
      planId: 'p1',
      kind: 'call_timeout',
      delayMs: 1_000,
      payload: { bookingId: 'b1' },
    });
    a.stop();

    clock += 5_000; // process was down
    const b = new TimerService(handle.db, { now });
    const fired: FiredTimer[] = [];
    b.on('*', (t) => void fired.push(t));
    expect(b.pending('p1')).toHaveLength(1);
    await b.tick();
    expect(fired).toHaveLength(1);
    expect(fired[0]?.lateMs).toBe(4_000);
    expect(fired[0]?.payload).toEqual({ bookingId: 'b1' });
  });

  it('fires in fireAt order and keeps going when a handler throws', async () => {
    const svc = new TimerService(handle.db, { now });
    const order: string[] = [];
    svc.on('custom', (t) => {
      order.push(String(t.payload['n']));
      if (t.payload['n'] === 1) throw new Error('boom');
    });
    svc.schedule({ planId: 'p', kind: 'custom', id: 't2', delayMs: 20, payload: { n: 2 } });
    svc.schedule({ planId: 'p', kind: 'custom', id: 't1', delayMs: 10, payload: { n: 1 } });
    clock += 100;
    await svc.tick();
    expect(order).toEqual(['1', '2']);
  });

  it('requires a delay for kinds without a deadline', () => {
    const svc = new TimerService(handle.db, { now });
    expect(() => svc.schedule({ planId: 'p', kind: 'custom' })).toThrow(/needs delayMs/);
  });
});
