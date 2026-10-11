import { describe, expect, it } from 'vitest';
import { forceSimulation } from 'd3-force';
import {
  createDrift,
  driftTarget,
  finaleFrame,
  randomPoint,
  seededRandom,
  softenVelocity,
} from './motion';

const bounds = { left: 40, right: 350, top: 220, bottom: 650 };
describe('independent bubble drift', () => {
  it('uses reproducible seeds for tests, with different arrangements on different runs', () => {
    expect(randomPoint(bounds, seededRandom(1))).toEqual(randomPoint(bounds, seededRandom(1)));
    expect(randomPoint(bounds, seededRandom(1))).not.toEqual(randomPoint(bounds, seededRandom(2)));
  });
  it('moves continuously and slowly across direction changes', () => {
    const random = seededRandom(7);
    const drift = createDrift(random);
    let previous = driftTarget(drift, 0, bounds, random);
    let maxStep = 0;
    for (let now = 16; now < 90000; now += 16) {
      const next = driftTarget(drift, now, bounds, random);
      maxStep = Math.max(maxStep, Math.hypot(next.x - previous.x, next.y - previous.y));
      previous = next;
    }
    expect(maxStep).toBeGreaterThan(0.01);
    expect(maxStep).toBeLessThan(0.6);
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

describe('readable motion under physics forces', () => {
  it('limits speed and sudden acceleration even when targets change or collisions push', () => {
    const node = { x: 0, y: 0, vx: 0, vy: 0 };
    let target = 300;
    const sim = forceSimulation([node])
      .velocityDecay(0.25)
      .force('seek', () => {
        node.vx += (target - node.x) * 0.002;
      })
      .force('gentle', () => {
        softenVelocity(node);
      })
      .stop();
    let previousX = node.x;
    let previousStep = 0;
    for (let frame = 0; frame < 720; frame++) {
      if (frame === 360) {
        expect(node.x).toBeGreaterThan(100);
        target = -300;
      }
      if (frame === 60) node.vx += 100;
      sim.tick();
      const step = node.x - previousX;
      expect(Math.abs(step)).toBeLessThanOrEqual(0.526);
      expect(Math.abs(step - previousStep)).toBeLessThanOrEqual(0.027);
      previousX = node.x;
      previousStep = step;
    }
    expect(node.x).toBeLessThan(100);
  });
  it('still lets the people reach the success bubble before the finale timeout', () => {
    const node = { x: 0, y: 0, vx: 0, vy: 0 };
    const sim = forceSimulation([node])
      .velocityDecay(0.25)
      .force('seek', () => {
        node.vx += (220 - node.x) * 0.005;
      })
      .force('gentle', () => {
        softenVelocity(node, true);
      })
      .stop();
    sim.tick(360);
    expect(Math.abs(node.x - 220)).toBeLessThan(20);
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
