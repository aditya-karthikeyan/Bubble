import { PlanEvent } from '@bubbleworks/shared';
import { describe, expect, it } from 'vitest';
import basic from '../../fixtures/basic.json';
import { computeLayout, sizes, type Size } from './layout';
import { phaseOf, reduceAll } from './view-model';

const BASIC = basic.map((e) => PlanEvent.parse(e));
const upTo = (type: PlanEvent['type']) =>
  BASIC.slice(0, BASIC.findIndex((e) => e.type === type) + 1);
const PHONE: Size = { w: 390, h: 844 };
const LAPTOP: Size = { w: 1440, h: 900 };

describe('arena layout', () => {
  it('keeps every visible target on screen, on a phone and a laptop', () => {
    for (const size of [PHONE, LAPTOP]) {
      for (let i = 1; i <= BASIC.length; i++) {
        const vm = reduceAll(BASIC.slice(0, i));
        const l = computeLayout(vm, phaseOf(vm), size);
        const visible = [
          ...Object.values(l.venues),
          ...Object.values(l.bubbles),
          ...Object.values(l.doers),
        ].filter((t) => t.opacity > 0);
        for (const t of visible) {
          expect(t.x - t.r, `${size.w} ${i} ${JSON.stringify(t)}`).toBeGreaterThanOrEqual(-1);
          expect(t.x + t.r).toBeLessThanOrEqual(size.w + 1);
          expect(t.y - t.r).toBeGreaterThanOrEqual(0);
          expect(t.y + t.r).toBeLessThanOrEqual(size.h);
        }
      }
    }
  });

  it('floats freely while gathering and settles once the crew agrees', () => {
    const gathering = reduceAll(upTo('bubble_left'));
    const locked = reduceAll(upTo('plan_locked'));
    const g = computeLayout(gathering, 'gathering', PHONE).bubbles['user_ava']!;
    const l = computeLayout(locked, 'locked', PHONE).bubbles['user_ava']!;
    expect(g.wander).toBeGreaterThan(l.wander * 5);
  });

  it('pulls each bubble toward the venue it scores highest', () => {
    const planId = BASIC[0]!.planId;
    const at = BASIC[0]!.at;
    const ev = (seq: number, e: Record<string, unknown>) =>
      PlanEvent.parse({ planId, at, seq, ...e });
    const vm = reduceAll([
      ev(1, { type: 'bubble_joined', bubble: { userId: 'a', displayName: 'A', status: 'fits' } }),
      ev(2, { type: 'bubble_joined', bubble: { userId: 'b', displayName: 'B', status: 'fits' } }),
      ev(3, { type: 'candidate_added', venue: { venueId: 'left', name: 'Left', cuisine: 'thai' } }),
      ev(4, {
        type: 'candidate_added',
        venue: { venueId: 'right', name: 'Right', cuisine: 'pizza' },
      }),
      ev(5, {
        type: 'round_complete',
        round: 1,
        scores: [
          { userId: 'a', venueId: 'left', score: 0.1 },
          { userId: 'a', venueId: 'right', score: 1 },
          { userId: 'b', venueId: 'left', score: 1 },
          { userId: 'b', venueId: 'right', score: 0.1 },
        ],
        bubbles: [],
        leaderVenueId: null,
      }),
    ]);
    const l = computeLayout(vm, 'convergence', LAPTOP);
    expect(l.bubbles['a']!.x).toBeGreaterThan(LAPTOP.w / 2);
    expect(l.bubbles['b']!.x).toBeLessThan(LAPTOP.w / 2);
  });

  it('wraps the merged crew in a consensus bubble, then splits four doers off it on lock', () => {
    const merged = reduceAll(upTo('bubble_merged'));
    const m = computeLayout(merged, 'convergence', PHONE);
    expect(m.consensus?.members).toEqual(['user_ava', 'user_ben', 'user_chloe', 'user_dev']);

    const vm = reduceAll(upTo('plan_locked'));
    const l = computeLayout(vm, phaseOf(vm), PHONE);
    expect(Object.keys(l.doers)).toEqual(['caller', 'inviter', 'splitter', 'watcher']);
    expect(l.doerOrigin).toEqual(l.consensus!.at);
    expect(l.venues['venue_demo']!.leader).toBe(true);
    expect(l.venues['venue_osm_w44343155']!.opacity).toBe(0);
    // Every member sits inside the consensus bubble.
    for (const id of l.consensus!.members) {
      const b = l.bubbles[id]!;
      expect(
        Math.hypot(b.x - l.consensus!.at.x, b.y - l.consensus!.at.y) + b.r,
      ).toBeLessThanOrEqual(l.consensus!.r + 1);
    }
  });

  it('sends a bubble that left off the top, faded', () => {
    const vm = reduceAll(upTo('bubble_left'));
    expect(computeLayout(vm, 'gathering', PHONE).bubbles['user_eli']).toBeUndefined();
    expect(sizes(PHONE).bubble).toBeGreaterThanOrEqual(24);
  });
});
