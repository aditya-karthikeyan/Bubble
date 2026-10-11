/**
 * Bubble physics on top of d3's integrator. Bubbles never pass through each other: they push
 * apart when they touch, veer around whatever lies on their way, and slide around the windows
 * on the desktop. A bubble flying into another (a person into the crew, the crew into the
 * venue) passes through that one only.
 */

export interface Body {
  id: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  /** Where it is headed this tick. */
  tx: number;
  ty: number;
  /** Collision radius: the orb plus room for its label. 0 means it doesn't collide. */
  body: number;
  /** Heavier bodies get pushed less. */
  mass: number;
  /** The body it is flying into right now; the two pass through each other. */
  into?: string;
  /** How hard it was bumped this tick, in px; the arena turns it into a jiggle. */
  hit?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One is flying into the other, or both are headed into the same bubble: they pass through. */
export const merging = (a: Body, b: Body) =>
  a.into === b.id || b.into === a.id || (a.into !== undefined && a.into === b.into);

/**
 * Push touching bodies apart, `share` of the overlap per tick (the lighter one moves further),
 * and cancel the velocity that would close them in again.
 */
export function separate(bodies: Body[], share = 0.6) {
  const live = bodies.filter((b) => b.body > 0);
  for (let i = 0; i < live.length; i++) {
    const a = live[i]!;
    for (let j = i + 1; j < live.length; j++) {
      const b = live[j]!;
      if (merging(a, b)) continue;
      let dx = b.x! - a.x!;
      let dy = b.y! - a.y!;
      let d = Math.hypot(dx, dy);
      const min = a.body + b.body;
      if (d >= min) continue;
      if (d < 1e-3) {
        // Exactly on top of each other: split along a fixed direction per pair.
        const angle = (i * 2.399 + j) % (Math.PI * 2);
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        d = 1;
      }
      const nx = dx / d;
      const ny = dy / d;
      const push = (min - d) * share;
      const wa = b.mass / (a.mass + b.mass);
      const wb = 1 - wa;
      a.x! -= nx * push * wa;
      a.y! -= ny * push * wa;
      b.x! += nx * push * wb;
      b.y! += ny * push * wb;
      a.hit = (a.hit ?? 0) + push * wa;
      b.hit = (b.hit ?? 0) + push * wb;
      const closing = ((b.vx ?? 0) - (a.vx ?? 0)) * nx + ((b.vy ?? 0) - (a.vy ?? 0)) * ny;
      if (closing < 0) {
        a.vx = (a.vx ?? 0) + nx * closing * wa;
        a.vy = (a.vy ?? 0) + ny * closing * wa;
        b.vx = (b.vx ?? 0) - nx * closing * wb;
        b.vy = (b.vy ?? 0) - ny * closing * wb;
      }
    }
  }
}

/**
 * Veer sideways around bodies on the way to the target, harder when one is dead ahead and
 * close, so a bubble flows around the others instead of shoving through them.
 */
export function steer(bodies: Body[], gain = 0.05) {
  const live = bodies.filter((b) => b.body > 0);
  for (const a of live) {
    const dx = a.tx - a.x!;
    const dy = a.ty - a.y!;
    const dist = Math.hypot(dx, dy);
    if (dist < a.body * 0.5) continue;
    const ux = dx / dist;
    const uy = dy / dist;
    for (const b of live) {
      if (b === a || merging(a, b)) continue;
      const ox = b.x! - a.x!;
      const oy = b.y! - a.y!;
      const ahead = ox * ux + oy * uy;
      const clear = a.body + b.body + 4;
      const reach = Math.min(dist + clear, clear * 2.5);
      if (ahead <= 0 || ahead > reach) continue;
      // How far b sits to the left of the path; left is (-uy, ux).
      const side = -ox * uy + oy * ux;
      if (Math.abs(side) >= clear) continue;
      const away = side > 0 ? -1 : side < 0 ? 1 : a.id < b.id ? 1 : -1;
      const push =
        (1 - Math.abs(side) / clear) * (1 - ahead / reach) * gain * (a.into ? 2.4 : 1) * away;
      a.vx = (a.vx ?? 0) - uy * push;
      a.vy = (a.vy ?? 0) + ux * push;
    }
  }
}

/** Push bodies out of rectangles (the windows), padded by `pad`, so they slide around them. */
export function avoidRects(bodies: Body[], rects: Rect[], pad = 8) {
  if (!rects.length) return;
  for (const b of bodies) {
    if (b.body <= 0) continue;
    for (const r of rects) {
      const left = r.x - pad;
      const right = r.x + r.w + pad;
      const top = r.y - pad;
      const bottom = r.y + r.h + pad;
      const cx = Math.min(right, Math.max(left, b.x!));
      const cy = Math.min(bottom, Math.max(top, b.y!));
      const dx = b.x! - cx;
      const dy = b.y! - cy;
      const d = Math.hypot(dx, dy);
      if (d >= b.body) continue;
      if (d === 0) {
        // Centre inside the window: leave by the nearest edge.
        const out = exit(b.x!, b.y!, left, right, top, bottom, b.body);
        b.x = b.x! + (out.x - b.x!) * 0.3;
        b.y = b.y! + (out.y - b.y!) * 0.3;
        continue;
      }
      const nx = dx / d;
      const ny = dy / d;
      b.x = b.x! + nx * (b.body - d) * 0.6;
      b.y = b.y! + ny * (b.body - d) * 0.6;
      const inward = (b.vx ?? 0) * nx + (b.vy ?? 0) * ny;
      if (inward < 0) {
        b.vx = (b.vx ?? 0) - nx * inward;
        b.vy = (b.vy ?? 0) - ny * inward;
      }
    }
  }
}

/**
 * A target point moved clear of every rectangle by `clearance`, so nothing keeps trying to
 * float under a window.
 */
export function clearOf(x: number, y: number, clearance: number, rects: Rect[], pad = 8) {
  let p = { x, y };
  for (const r of rects) {
    const left = r.x - pad;
    const right = r.x + r.w + pad;
    const top = r.y - pad;
    const bottom = r.y + r.h + pad;
    if (
      p.x > left - clearance &&
      p.x < right + clearance &&
      p.y > top - clearance &&
      p.y < bottom + clearance
    ) {
      p = exit(p.x, p.y, left, right, top, bottom, clearance);
    }
  }
  return p;
}

/** The nearest point at least `clearance` outside a rectangle's edges. */
function exit(
  x: number,
  y: number,
  left: number,
  right: number,
  top: number,
  bottom: number,
  clearance: number,
) {
  const options = [
    { d: x - left, x: left - clearance, y },
    { d: right - x, x: right + clearance, y },
    { d: y - top, x, y: top - clearance },
    { d: bottom - y, x, y: bottom + clearance },
  ];
  return options.reduce((best, o) => (o.d < best.d ? o : best));
}
