export interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
export type Random = () => number;

/** A separate seed per replay; injectable for reproducible motion tests. */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashSeed(id: string, seed = 0): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}
export function randomPoint(b: Bounds, random: Random) {
  return {
    x: b.left + random() * Math.max(0, b.right - b.left),
    y: b.top + random() * Math.max(0, b.bottom - b.top),
  };
}
export interface Drift {
  u: number;
  v: number;
  fromU: number;
  fromV: number;
  toU: number;
  toV: number;
  startedAt: number | null;
  duration: number;
}
export function createDrift(random: Random): Drift {
  const u = random();
  const v = random();
  return { u, v, fromU: u, fromV: v, toU: u, toV: v, startedAt: null, duration: 0 };
}
/** Long, eased paths retain random directions without jumping to new destinations. */
export function driftTarget(drift: Drift, now: number, bounds: Bounds, random: Random) {
  if (drift.startedAt === null || now >= drift.startedAt + drift.duration) {
    if (drift.startedAt !== null) {
      drift.u = drift.toU;
      drift.v = drift.toV;
    }
    drift.fromU = drift.u;
    drift.fromV = drift.v;
    drift.toU = Math.min(1, Math.max(0, drift.u + (random() - 0.5) * 0.6));
    drift.toV = Math.min(1, Math.max(0, drift.v + (random() - 0.5) * 0.6));
    drift.startedAt = now;
    drift.duration = 10000 + random() * 6000;
  }
  const t = Math.min(1, Math.max(0, (now - drift.startedAt) / drift.duration));
  // Quintic easing has zero velocity and acceleration at each turn.
  const eased = t * t * t * (t * (t * 6 - 15) + 10);
  drift.u = drift.fromU + (drift.toU - drift.fromU) * eased;
  drift.v = drift.fromV + (drift.toV - drift.fromV) * eased;
  return {
    x: bounds.left + drift.u * Math.max(0, bounds.right - bounds.left),
    y: bounds.top + drift.v * Math.max(0, bounds.bottom - bounds.top),
  };
}

export interface MotionVelocity {
  vx?: number;
  vy?: number;
  previousVx?: number;
  previousVy?: number;
}
/** Apply after collision and attraction forces so neither can fling a label across the page. */
export function softenVelocity(node: MotionVelocity, absorbing = false) {
  const maxSpeed = absorbing ? 1.8 : 0.7;
  const maxAcceleration = absorbing ? 0.08 : 0.035;
  const previousX = node.previousVx ?? 0;
  const previousY = node.previousVy ?? 0;
  const dx = (node.vx ?? 0) - previousX;
  const dy = (node.vy ?? 0) - previousY;
  const acceleration = Math.min(1, maxAcceleration / (Math.hypot(dx, dy) || 1));
  let vx = previousX + dx * acceleration;
  let vy = previousY + dy * acceleration;
  const speed = Math.min(1, maxSpeed / (Math.hypot(vx, vy) || 1));
  vx *= speed;
  vy *= speed;
  node.vx = vx;
  node.vy = vy;
  // Remember the force output so damping cannot reset the acceleration ramp each frame.
  node.previousVx = vx;
  node.previousVy = vy;
}

/** One-shot timeline; completion remains stable until the plan/replay is reset. */
export function finaleFrame(elapsed: number, initial: number, maximum: number, reduced: boolean) {
  const grow = Math.min(1, Math.max(0, elapsed / 2400));
  const burst = Math.min(1, Math.max(0, (elapsed - 2400) / 850));
  if (reduced || burst === 1)
    return {
      radius: maximum,
      bubbleOpacity: 0,
      burstOpacity: 0,
      burstProgress: 1,
      successOpacity: 1,
    };
  return {
    radius: initial + (maximum - initial) * (grow * grow * (3 - 2 * grow)),
    bubbleOpacity: elapsed < 2400 ? 1 : 0,
    burstOpacity: elapsed >= 2400 ? 1 - burst : 0,
    burstProgress: burst,
    successOpacity: elapsed >= 2400 ? Math.min(1, burst * 2) : 0,
  };
}
