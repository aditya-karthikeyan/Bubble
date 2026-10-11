import { describe, expect, it } from 'vitest';
import { createDrift, driftTarget, finaleFrame, randomPoint, seededRandom } from './motion';

const bounds = { left: 40, right: 350, top: 220, bottom: 650 };
describe('independent bubble drift', () => {
  it('uses reproducible seeds for tests, with different arrangements on different runs', () => {
    expect(randomPoint(bounds, seededRandom(1))).toEqual(randomPoint(bounds, seededRandom(1)));
    expect(randomPoint(bounds, seededRandom(1))).not.toEqual(randomPoint(bounds, seededRandom(2)));
  });
  it('changes directions independently and stays inside the viewing area', () => {
    const random = seededRandom(19);
    const a = createDrift(random);
    const b = createDrift(random);
    const points = [];
    for (let now = 0; now < 60000; now += 500) {
      const p = driftTarget(a, now, bounds, random);
      const q = driftTarget(b, now, bounds, random);
      expect(p).not.toEqual(q);
      expect(p.x).toBeGreaterThanOrEqual(bounds.left);
      expect(p.x).toBeLessThanOrEqual(bounds.right);
      expect(p.y).toBeGreaterThanOrEqual(bounds.top);
      expect(p.y).toBeLessThanOrEqual(bounds.bottom);
      points.push(`${p.x},${p.y}`);
    }
    expect(new Set(points).size).toBeGreaterThan(12);
  });
});

describe('success bubble finale', () => {
  it('grows before popping, then leaves a persistent success state', () => {
    const start = finaleFrame(0, 60, 140, false);
    const grown = finaleFrame(1800, 60, 140, false);
    const pop = finaleFrame(2600, 60, 140, false);
    const done = finaleFrame(5000, 60, 140, false);
    expect(start.radius).toBe(60);
    expect(grown.radius).toBeGreaterThan(start.radius);
    expect(grown.bubbleOpacity).toBe(1);
    expect(pop.bubbleOpacity).toBe(0);
    expect(pop.burstOpacity).toBeGreaterThan(0);
    expect(done.burstOpacity).toBe(0);
    expect(done.successOpacity).toBe(1);
    expect(finaleFrame(20000, 60, 140, false)).toEqual(done);
  });
  it('skips the growth and burst for reduced motion', () => {
    expect(finaleFrame(0, 60, 140, true)).toMatchObject({
      bubbleOpacity: 0,
      burstOpacity: 0,
      successOpacity: 1,
    });
  });
});
