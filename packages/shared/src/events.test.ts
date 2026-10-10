import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  EVENT_TYPES,
  FORBIDDEN_PAYLOAD_KEYS,
  PlanEvent,
  parsePlanEvent,
  safeParsePlanEvent,
} from './events.js';

const at = '2026-10-10T19:00:00.000Z';

describe('PlanEvent contract', () => {
  it('covers every event type in the God Prompt', () => {
    const covered = PlanEvent.options.map((o) => o.shape.type.value);
    expect([...covered].sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('parses a valid round_complete', () => {
    const event = parsePlanEvent({
      type: 'round_complete',
      planId: 'plan_1',
      at,
      round: 1,
      scores: [{ userId: 'user_ava', venueId: 'venue_1', score: 0.8 }],
      bubbles: [{ userId: 'user_ava', displayName: 'Ava', status: 'fits' }],
      leaderVenueId: 'venue_1',
    });
    expect(event.type).toBe('round_complete');
  });

  it('rejects a bubble status outside the public set', () => {
    expect(
      safeParsePlanEvent({
        type: 'bubble_joined',
        planId: 'plan_1',
        at,
        bubble: { userId: 'user_ava', displayName: 'Ava', status: 'vegetarian' },
      }),
    ).toBeNull();
  });

  it('rejects unknown event types', () => {
    expect(safeParsePlanEvent({ type: 'budget_revealed', planId: 'plan_1', at })).toBeNull();
  });

  it('never defines a payload key that could leak a constraint', () => {
    const forbidden = new Set<string>(FORBIDDEN_PAYLOAD_KEYS);
    const offenders: string[] = [];
    for (const option of PlanEvent.options) {
      walk(option, option.shape.type.value, (path) => {
        const leaf = path.split('.').at(-1) ?? '';
        if (forbidden.has(leaf)) offenders.push(path);
      });
    }
    expect(offenders).toEqual([]);
  });
});

function walk(schema: z.ZodType, path: string, visit: (path: string) => void): void {
  const def = schema.def as { type: string };
  if (def.type === 'object') {
    for (const [key, child] of Object.entries((schema as z.ZodObject).shape)) {
      const childPath = `${path}.${key}`;
      visit(childPath);
      walk(child as z.ZodType, childPath, visit);
    }
    return;
  }
  if (def.type === 'array') {
    walk((schema as z.ZodArray<z.ZodType>).element, path, visit);
    return;
  }
  if (def.type === 'optional' || def.type === 'nullable' || def.type === 'default') {
    walk((schema as z.ZodOptional<z.ZodType>).unwrap(), path, visit);
  }
}
