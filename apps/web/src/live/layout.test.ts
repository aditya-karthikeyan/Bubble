import { PlanEvent } from '@bubbleworks/shared';
import { describe, expect, it } from 'vitest';
import basic from '../../fixtures/basic.json';
import { CENTER, H, W, computeLayout } from './layout';
import { phaseOf, reduceAll } from './view-model';

const BASIC = basic.map((e) => PlanEvent.parse(e));
const upTo = (type: PlanEvent['type']) =>
  BASIC.slice(0, BASIC.findIndex((e) => e.type === type) + 1);

describe('arena layout', () => {
  it('keeps every target inside the arena, except bubbles that left', () => {
    for (let i = 1; i <= BASIC.length; i++) {
      const vm = reduceAll(BASIC.slice(0, i));
      const l = computeLayout(vm, phaseOf(vm));
      for (const p of Object.values(l.venues)) {
        expect(p.x).toBeGreaterThan(0);
        expect(p.x).toBeLessThan(W);
      }
      for (const b of vm.bubbles.filter((x) => x.present)) {
        const p = l.bubbles[b.userId]!;
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(W);
        expect(p.y).toBeGreaterThan(0);
        expect(p.y).toBeLessThan(H);
      }
    }
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
    const l = computeLayout(vm, 'convergence');
    // A starts on the left and B on the right; each crosses toward its favorite.
    expect(l.bubbles['a']!.x).toBeGreaterThan(W / 2);
    expect(l.bubbles['b']!.x).toBeLessThan(W / 2);
  });

  it('gathers everyone into the consensus bubble and splits four doers around it on lock', () => {
    const vm = reduceAll(upTo('plan_locked'));
    const l = computeLayout(vm, phaseOf(vm));
    expect(l.consensus).toMatchObject(CENTER);
    expect(Object.keys(l.doers)).toEqual(['caller', 'inviter', 'splitter', 'watcher']);
    expect(l.venues['venue_demo']!.leader).toBe(true);
    expect(l.venues['venue_osm_w44343155']!.dim).toBe(true);
  });

  it('sends a bubble that left off the top', () => {
    const vm = reduceAll(BASIC);
    expect(computeLayout(vm, phaseOf(vm)).bubbles['user_eli']).toBeUndefined();
    const left = reduceAll([
      ...upTo('bubble_joined'),
      PlanEvent.parse({
        type: 'bubble_left',
        planId: BASIC[0]!.planId,
        at: BASIC[0]!.at,
        seq: 99,
        userId: 'user_ava',
        reason: 'out',
      }),
    ]);
    expect(computeLayout(left, 'gathering').bubbles['user_ava']!.y).toBeLessThan(0);
  });
});
