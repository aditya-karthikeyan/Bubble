import { PlanEvent } from '@bubbleworks/shared';
import { describe, expect, it } from 'vitest';
import basic from '../../fixtures/basic.json';
import { gapAfter } from './use-plan-feed';

const BASIC = basic.map((e) => PlanEvent.parse(e));
const round = BASIC.find((e) => e.type === 'round_complete')!;
const merged = BASIC.find((e) => e.type === 'bubble_merged')!;

describe('live page pacing', () => {
  it('holds after a solver round live, so the drift is visible even when the engine bursts', () => {
    expect(gapAfter(round, merged, 'live', 1)).toBeGreaterThanOrEqual(2000);
  });

  it('recaps history quickly for a late viewer', () => {
    const recap = BASIC.reduce((t, e, i) => t + gapAfter(e, BASIC[i + 1], 'recap', 0), 0);
    expect(recap).toBeLessThan(12_000);
    expect(gapAfter(round, merged, 'recap', 0)).toBeLessThan(gapAfter(round, merged, 'live', 1));
  });

  it('catches up when a live backlog builds', () => {
    expect(gapAfter(round, merged, 'live', 20)).toBeLessThan(300);
  });
});
