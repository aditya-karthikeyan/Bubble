import { describe, expect, it } from 'vitest';
import { avoidRects, clearOf, separate, steer, type Body } from './physics';

const body = (id: string, x: number, y: number, extra: Partial<Body> = {}): Body => ({
  id,
  x,
  y,
  vx: 0,
  vy: 0,
  tx: x,
  ty: y,
  body: 20,
  mass: 400,
  ...extra,
});

describe('bubble physics', () => {
  it('pushes overlapping bubbles apart until they only touch', () => {
    const a = body('a', 100, 100);
    const b = body('b', 110, 100);
    for (let i = 0; i < 20; i++) separate([a, b]);
    expect(Math.hypot(b.x! - a.x!, b.y! - a.y!)).toBeGreaterThan(39);
    // Each side records the bump, so it can jiggle.
    expect(a.hit!).toBeGreaterThan(0);
    expect(b.hit!).toBeGreaterThan(0);
    // The heavier one moves less.
    const big = body('big', 0, 0, { mass: 4000 });
    const small = body('small', 10, 0);
    separate([big, small]);
    expect(Math.abs(small.x! - 10)).toBeGreaterThan(Math.abs(big.x!));
  });

  it('lets a bubble pass into the one it is absorbed by, and past others headed there too', () => {
    const crew = body('crew', 100, 100, { body: 60 });
    const ava = body('ava', 110, 100, { into: 'crew' });
    const ben = body('ben', 112, 100, { into: 'crew' });
    separate([crew, ava, ben]);
    expect([ava.x, ben.x]).toEqual([110, 112]);
  });

  it('veers around a bubble in the way instead of heading through it', () => {
    const a = body('a', 0, 0, { tx: 200, ty: 0 });
    const b = body('b', 50, 3);
    steer([a, b]);
    // b sits slightly left (down-screen) of the path, so a veers the other way.
    expect(a.vy!).toBeLessThan(0);
    const clear = body('c', 0, 0, { tx: 200, ty: 0 });
    steer([clear, body('far', 50, 120)]);
    expect(clear.vy).toBe(0);
  });

  it('keeps bubbles and their targets out of windows', () => {
    const win = { x: 100, y: 100, w: 200, h: 100 };
    const a = body('a', 95, 150);
    avoidRects([a], [win]);
    expect(a.x!).toBeLessThan(95);
    const t = clearOf(200, 150, 20, [win]);
    const inside =
      t.x > win.x - 20 && t.x < win.x + win.w + 20 && t.y > win.y - 20 && t.y < win.y + win.h + 20;
    expect(inside).toBe(false);
    expect(clearOf(500, 500, 20, [win])).toEqual({ x: 500, y: 500 });
  });
});
