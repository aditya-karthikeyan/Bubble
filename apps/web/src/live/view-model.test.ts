import { PlanEvent } from '@bubbleworks/shared';
import { describe, expect, it } from 'vitest';
import basic from '../../fixtures/basic.json';
import deadlock from '../../fixtures/deadlock.json';
import { EMPTY, phaseOf, reduce, reduceAll, type Phase } from './view-model';

const parse = (events: unknown[]) => events.map((e) => PlanEvent.parse(e));
const BASIC = parse(basic);
const DEADLOCK = parse(deadlock);

function phases(events: PlanEvent[]): Phase[] {
  const seen: Phase[] = [];
  let vm = EMPTY;
  for (const e of events) {
    vm = reduce(vm, e);
    const p = phaseOf(vm);
    if (seen.at(-1) !== p) seen.push(p);
  }
  return seen;
}

describe('live page view model', () => {
  it('walks the basic plan through gathering, candidates, convergence, lock, and summary', () => {
    expect(phases(BASIC)).toEqual(['gathering', 'candidates', 'convergence', 'locked', 'summary']);
    const vm = reduceAll(BASIC);
    expect(vm.bubbles.filter((b) => b.present).map((b) => b.displayName)).toEqual([
      'Ava',
      'Ben',
      'Chloe',
      'Dev',
    ]);
    expect(vm.venues).toHaveLength(5);
    expect(vm.merged?.venueId).toBe('venue_demo');
    expect(vm.booking).toMatchObject({ partySize: 4, venue: { name: 'The Demo Table' } });
    expect(vm.doers.caller?.state).toBe('done');
    expect(vm.doers.watcher?.state).toBe('working');
  });

  it('shows the deadlock pulse while a private ask is out', () => {
    expect(phases(DEADLOCK)).toContain('deadlock');
    const vm = reduceAll(DEADLOCK);
    expect(vm.openAsks).toEqual([]);
    expect(phaseOf(vm)).toBe('summary');
  });

  it('ignores events it has already seen, so replay plus live never double-applies', () => {
    const once = reduceAll(BASIC);
    expect(reduceAll(BASIC, once)).toBe(once);
  });

  it('lands a late joiner on the current phase from the replay alone', () => {
    const upToLock = BASIC.slice(0, BASIC.findIndex((e) => e.type === 'plan_locked') + 1);
    expect(phaseOf(reduceAll(upToLock))).toBe('locked');
  });

  it('carries only page-safe fields', () => {
    const json = JSON.stringify([...BASIC, ...DEADLOCK]);
    for (const banned of ['budget', 'diet', 'allerg', 'distance', 'phone', '"text"']) {
      expect(json.toLowerCase()).not.toContain(banned);
    }
  });
});
