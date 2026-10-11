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
  it('randomizes people while keeping helper agents grouped consistently', () => {
    const vm = reduceAll(upTo('plan_locked'));
    const first = computeLayout(vm, 'locked', LAPTOP, 123);
    expect(computeLayout(vm, 'locked', LAPTOP, 123)).toEqual(first);
    const second = computeLayout(vm, 'locked', LAPTOP, 456);
    expect(second.bubbles).not.toEqual(first.bubbles);
    expect(second.doers).toEqual(first.doers);
    const candidates = reduceAll(upTo('round_complete'));
    expect(computeLayout(candidates, 'convergence', LAPTOP, 123).venues).not.toEqual(
      computeLayout(candidates, 'convergence', LAPTOP, 456).venues,
    );
  });
  it('keeps candidate bubbles clear of the navigation and phase panel', () => {
    const vm = reduceAll(upTo('round_complete'));
    for (const size of [PHONE, LAPTOP]) {
      const layout = computeLayout(vm, phaseOf(vm), size);
      for (const venue of Object.values(layout.venues)) {
        expect(venue.y - venue.r - venue.wander).toBeGreaterThanOrEqual(200);
      }
    }
  });
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
    const swapped = computeLayout(
      { ...vm, scores: { a: vm.scores['b']!, b: vm.scores['a']! } },
      'convergence',
      LAPTOP,
    );
    const towardRight = l.venues['right']!.x - l.venues['left']!.x;
    expect((l.bubbles['a']!.x - swapped.bubbles['a']!.x) * towardRight).toBeGreaterThan(0);
    expect((l.bubbles['b']!.x - swapped.bubbles['b']!.x) * towardRight).toBeLessThan(0);
  });

  it('gathers the merged crew, then sends four doers out on lock', () => {
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

  it('flies the crew into the destination and absorbs them once booked, one after another', () => {
    const vm = reduceAll(BASIC);
    const l = computeLayout(vm, 'summary', PHONE);
    const venue = l.venues['venue_demo']!;
    expect(venue.leader).toBe(true);
    expect(l.consensus?.absorbing).toBe(true);
    const orders = l.consensus!.members.map((id) => l.bubbles[id]!.absorb);
    expect(orders.map((a) => a?.venueId)).toEqual([
      'venue_demo',
      'venue_demo',
      'venue_demo',
      'venue_demo',
    ]);
    expect(orders.map((a) => a?.order)).toEqual([0, 1, 2, 3]);
    // The doers re-form around the destination.
    for (const d of Object.values(l.doers)) {
      expect(Math.hypot(d.x - venue.x, d.y - venue.y)).toBeGreaterThan(venue.r);
    }
  });

  it('ends as one bubble: the doers are absorbed into the destination once the plan is complete', () => {
    const vm = reduceAll(BASIC);
    expect(phaseOf(vm)).toBe('complete');
    const l = computeLayout(vm, 'complete', PHONE);
    expect(Object.values(l.doers).map((d) => d.absorb?.venueId)).toEqual([
      'venue_demo',
      'venue_demo',
      'venue_demo',
      'venue_demo',
    ]);
    const people = Object.values(l.bubbles).filter((b) => b.opacity > 0);
    expect(people.every((b) => b.absorb?.venueId === 'venue_demo')).toBe(true);
    expect(l.venues['venue_demo']!.r).toBeGreaterThan(
      computeLayout(vm, 'summary', PHONE).venues['venue_demo']!.r,
    );
  });

  it('keeps the doers in a compact group with only gentle drift', () => {
    const vm = reduceAll(BASIC);
    const l = computeLayout(vm, 'summary', PHONE);
    const ds = Object.values(l.doers);
    expect(ds.every((d) => d.wander > 0 && d.wander < d.r * 0.2)).toBe(true);
    expect(Math.max(...ds.map((d) => d.x)) - Math.min(...ds.map((d) => d.x))).toBeLessThan(300);
    const dist = ds.map((d) =>
      Math.round(Math.hypot(d.x - l.venues['venue_demo']!.x, d.y - l.venues['venue_demo']!.y)),
    );
    expect(new Set(dist).size).toBeGreaterThan(1);
  });

  it('sends a bubble that left off the top, faded', () => {
    const vm = reduceAll(upTo('bubble_left'));
    expect(computeLayout(vm, 'gathering', PHONE).bubbles['user_eli']).toBeUndefined();
    expect(sizes(PHONE).bubble).toBeGreaterThanOrEqual(24);
  });
});
