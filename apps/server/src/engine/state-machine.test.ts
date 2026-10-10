import { PlanState } from '@bubbleworks/shared';
import { describe, expect, it } from 'vitest';
import { canTransition, isTerminal, targetsFrom, type TransitionContext } from './state-machine.js';

const ctx = (over: Partial<TransitionContext> = {}): TransitionContext => ({
  state: 'IDLE',
  resumeState: null,
  chosenVenueId: null,
  startAt: null,
  inCount: 4,
  ...over,
});

describe('state machine table', () => {
  it('every state has a row', () => {
    for (const s of PlanState.options) expect(() => targetsFrom(s)).not.toThrow();
  });

  it('follows the happy path', () => {
    const path: PlanState[] = [
      'DETECTED',
      'GATHERING',
      'DELIBERATING',
      'LOCKED',
      'BOOKING',
      'BOOKED',
      'DAY_OF',
      'CLOSED',
    ];
    let state: PlanState = 'IDLE';
    for (const to of path) {
      const r = canTransition(
        to,
        ctx({ state, chosenVenueId: 'v', startAt: '2026-10-10T23:00:00Z' }),
      );
      expect(r, `${state} -> ${to}`).toEqual({ ok: true });
      state = to;
    }
  });

  it('rejects edges not in the table', () => {
    expect(canTransition('BOOKED', ctx({ state: 'GATHERING' }))).toMatchObject({ ok: false });
    expect(canTransition('IDLE', ctx({ state: 'DETECTED' }))).toMatchObject({ ok: false });
  });

  it('rejects self transitions and terminal exits', () => {
    expect(canTransition('GATHERING', ctx({ state: 'GATHERING' }))).toMatchObject({ ok: false });
    for (const t of ['CLOSED', 'CANCELLED', 'FAILED'] as const) {
      expect(isTerminal(t)).toBe(true);
      expect(canTransition('DETECTED', ctx({ state: t }))).toMatchObject({ ok: false });
    }
  });

  it('guards party size into DELIBERATING', () => {
    expect(canTransition('DELIBERATING', ctx({ state: 'GATHERING', inCount: 1 }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('at least 2'),
    });
    expect(canTransition('DELIBERATING', ctx({ state: 'GATHERING', inCount: 2 }))).toEqual({
      ok: true,
    });
  });

  it('guards LOCKED on venue and start time', () => {
    expect(canTransition('LOCKED', ctx({ state: 'DELIBERATING' }))).toMatchObject({ ok: false });
    expect(
      canTransition('LOCKED', ctx({ state: 'DELIBERATING', chosenVenueId: 'v' })),
    ).toMatchObject({
      ok: false,
      reason: 'no start time',
    });
    expect(
      canTransition('LOCKED', ctx({ state: 'DEADLOCK', chosenVenueId: 'v', startAt: 'x' })),
    ).toEqual({ ok: true });
  });

  it('PAUSED returns only to the saved state', () => {
    expect(canTransition('PAUSED', ctx({ state: 'LOCKED' }))).toEqual({ ok: true });
    expect(canTransition('BOOKING', ctx({ state: 'PAUSED', resumeState: 'LOCKED' }))).toMatchObject(
      {
        ok: false,
      },
    );
    expect(canTransition('LOCKED', ctx({ state: 'PAUSED', resumeState: 'LOCKED' }))).toEqual({
      ok: true,
    });
    expect(canTransition('CANCELLED', ctx({ state: 'PAUSED', resumeState: 'LOCKED' }))).toEqual({
      ok: true,
    });
    expect(canTransition('LOCKED', ctx({ state: 'PAUSED', resumeState: null }))).toMatchObject({
      ok: false,
    });
  });

  it('allows reruns and modifications', () => {
    expect(canTransition('DELIBERATING', ctx({ state: 'LOCKED' }))).toEqual({ ok: true });
    expect(canTransition('DELIBERATING', ctx({ state: 'BOOKING' }))).toEqual({ ok: true });
    expect(canTransition('BOOKING', ctx({ state: 'BOOKED' }))).toEqual({ ok: true });
    expect(canTransition('GATHERING', ctx({ state: 'DELIBERATING' }))).toEqual({ ok: true });
  });
});
