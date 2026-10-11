import { PlanEvent } from '@bubbleworks/shared';
import { describe, expect, it } from 'vitest';
import basic from '../../fixtures/basic.json';
import { joinNames, stepOf, stepSummary } from './steps';
import { reduceAll } from './view-model';

const BASIC = basic.map((e) => PlanEvent.parse(e));

describe('plan step pages', () => {
  it('maps every phase to a step', () => {
    expect(stepOf('gathering')).toBe(0);
    expect(stepOf('deadlock')).toBe(1);
    expect(stepOf('locked')).toBe(2);
    expect(stepOf('complete')).toBe(3);
    expect(stepOf('closed')).toBe(1);
  });

  it('tells each step of a finished plan from page-visible facts only', () => {
    const vm = reduceAll(BASIC);
    const gather = stepSummary(0, vm).lines.join(' ');
    expect(gather).toContain('Ava, Ben, Chloe and Dev are in.');
    expect(stepSummary(1, vm).lines.join(' ')).toContain(
      'Agreed on The Demo Table, backup Sup Dogs.',
    );
    expect(stepSummary(2, vm).lines).toContain('Caller: Booked');
    expect(stepSummary(3, vm).lines[0]).toMatch(/^The Demo Table at .+, table for 4 under Ava\.$/);
    // Nothing about budgets, diets, or distances ever shows up.
    const all = [0, 1, 2, 3].flatMap((i) => stepSummary(i, vm).lines).join(' ');
    expect(all).not.toMatch(/budget|\$|diet|allerg|mile|km/i);
  });

  it('names whoever dropped out', () => {
    const planId = BASIC[0]!.planId;
    const at = BASIC[0]!.at;
    const vm = reduceAll([
      PlanEvent.parse({
        type: 'bubble_joined',
        planId,
        at,
        seq: 1,
        bubble: { userId: 'a', displayName: 'Ava', status: 'fits' },
      }),
      PlanEvent.parse({
        type: 'bubble_joined',
        planId,
        at,
        seq: 2,
        bubble: { userId: 'e', displayName: 'Eli', status: 'fits' },
      }),
      PlanEvent.parse({ type: 'bubble_left', planId, at, seq: 3, userId: 'e', reason: 'out' }),
    ]);
    expect(stepSummary(0, vm).lines.slice(0, 2)).toEqual(['Ava is in.', 'Eli dropped out.']);
  });

  it('joins names the way people say them', () => {
    expect(joinNames(['Ava'])).toBe('Ava');
    expect(joinNames(['Ava', 'Ben'])).toBe('Ava and Ben');
    expect(joinNames(['Ava', 'Ben', 'Chloe'])).toBe('Ava, Ben and Chloe');
  });
});
