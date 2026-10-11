/**
 * Where everything wants to be on a full-screen arena of any size. Pure: the force simulation
 * floats each node around its target with a `wander` radius that shrinks as the crew converges,
 * so bubbles drift freely while gathering and settle tight once they agree.
 */
import type { DoerKind } from '@bubbleworks/shared';
import { DOER_KINDS, type Phase, type ViewModel } from './view-model';
import { hashSeed, randomPoint, seededRandom } from './motion';

export interface Size {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Target extends Point {
  r: number;
  /** How far the node floats around its target, in px. */
  wander: number;
  opacity: number;
  /** Booked: fly into this venue and get absorbed, in this order. */
  absorb?: { venueId: string; order: number };
}

export interface Layout {
  venues: Record<string, Target & { leader: boolean; dim: boolean }>;
  bubbles: Record<string, Target>;
  /** Bubbles the consensus bubble wraps, and where it sits. */
  consensus: { members: string[]; at: Point; r: number; absorbing: boolean } | null;
  doers: Partial<Record<DoerKind, Target>>;
  /** Where doers are born when they split off: the consensus centre. */
  doerOrigin: Point | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Radii scale with the screen, within readable bounds. */
export function sizes(size: Size) {
  const m = Math.min(size.w, size.h * 0.7);
  return {
    bubble: clamp(m / 13, 24, 40),
    venue: clamp(m / 14, 24, 44),
    doer: clamp(m / 11, 30, 48),
  };
}

/**
 * Space the window chrome leaves free: the plan window on top, the taskbar below, and the
 * booking dialog above the taskbar once the plan settles.
 */
export function safeArea(size: Size, sheet: boolean) {
  const top = size.h <= 650 && size.w > 760 ? 150 : size.w <= 760 ? 204 : 196;
  const bottom = sheet ? 250 : 64;
  return { top, bottom: size.h - bottom, height: size.h - bottom - top };
}

/** Random arrangements remain stable within a replay, even when members join or leave. */
export function computeLayout(vm: ViewModel, phase: Phase, size: Size, seed = 0): Layout {
  const point = (id: string, c: Point, rx: number, ry: number) =>
    randomPoint(
      { left: c.x - rx, right: c.x + rx, top: c.y - ry, bottom: c.y + ry },
      seededRandom(hashSeed(id, seed)),
    );
  const s = sizes(size);
  const complete = phase === 'complete';
  const booked = phase === 'summary' || complete;
  const settled = phase === 'locked' || booked;
  const area = safeArea(size, settled || phase === 'closed');
  const span = Math.min(size.w * 0.84, 960);
  const centre: Point = { x: size.w / 2, y: area.top + area.height * (settled ? 0.58 : 0.6) };

  // No rows or fixed slots: each venue has its own random anchor in the upper arena.
  const live = vm.venues;
  const leaderId = vm.locked?.venue.venueId ?? vm.merged?.venueId ?? vm.leaderVenueId;
  const slot: Record<string, Point> = {};
  live.forEach((v) => {
    slot[v.venueId] = point(
      `venue:${v.venueId}`,
      { x: size.w / 2, y: area.top + s.venue * 3.1 },
      Math.max(0, span / 2 - s.venue * 1.5),
      s.venue * 1.15,
    );
  });
  const venues: Layout['venues'] = {};
  for (const v of live) {
    const chosen = v.venueId === leaderId;
    const gone = v.eliminated || (settled && !chosen);
    // The chosen place waits on top while locked, then becomes the hero at the centre once booked.
    const at =
      booked && chosen
        ? { ...centre }
        : settled && chosen
          ? { x: size.w / 2, y: area.top + s.venue * 1.1 }
          : slot[v.venueId]!;
    venues[v.venueId] = {
      ...at,
      y: gone ? -s.venue * 3 : at.y,
      r:
        complete && chosen
          ? s.venue * 2.4
          : booked && chosen
            ? s.venue * 1.7
            : chosen && (vm.merged || settled)
              ? s.venue * 1.25
              : s.venue,
      wander: gone ? 0 : settled ? s.venue * 0.15 : s.venue * 0.9,
      opacity: gone ? 0 : 1,
      leader: chosen,
      dim: gone,
    };
  }

  // People.
  const present = vm.bubbles.filter((b) => b.present).map((b) => b.userId);
  const merged = settled
    ? present
    : (vm.merged?.userIds.filter((id) => present.includes(id)) ?? []);
  const clusterAt: Point | null = settled
    ? { ...centre }
    : vm.merged && slot[vm.merged.venueId]
      ? { x: slot[vm.merged.venueId]!.x, y: slot[vm.merged.venueId]!.y + s.venue * 5 }
      : null;
  const inside = s.bubble * (settled ? 0.62 : 0.8);
  const consensusR = merged.length ? inside * (1.25 + Math.sqrt(merged.length) * 1.05) : 0;
  if (clusterAt) {
    // Keep the whole consensus bubble on screen, even under an edge venue.
    clusterAt.x = clamp(clusterAt.x, consensusR + 8, size.w - consensusR - 8);
  }

  const bubbles: Layout['bubbles'] = {};
  const roam = { x: size.w * 0.36, y: area.height * 0.3 };
  present.forEach((id) => {
    const home = point(id, centre, roam.x, roam.y);
    const k = merged.indexOf(id);
    if (k >= 0 && clusterAt) {
      // Gather loosely: each person still chooses independent directions.
      const room = Math.max(0, consensusR - inside * 1.6);
      const angle = seededRandom(hashSeed(`angle:${id}`, seed))() * Math.PI * 2;
      const radius = seededRandom(hashSeed(`radius:${id}`, seed))() * room;
      const at = {
        x: clusterAt.x + Math.cos(angle) * radius,
        y: clusterAt.y + Math.sin(angle) * radius,
      };
      bubbles[id] = {
        ...at,
        r: inside,
        wander: booked ? 0 : room * 0.45,
        opacity: 1,
        ...(booked && leaderId ? { absorb: { venueId: leaderId, order: k } } : {}),
      };
      return;
    }
    const scores = vm.scores[id];
    let pulled: Point | null = null;
    if (scores) {
      let wx = 0;
      let wy = 0;
      let ws = 0;
      for (const v of live) {
        if (v.eliminated) continue;
        const w = (scores[v.venueId] ?? 0) ** 2;
        wx += w * slot[v.venueId]!.x;
        wy += w * (slot[v.venueId]!.y + s.venue * 4.2);
        ws += w;
      }
      if (ws > 0) pulled = { x: wx / ws, y: wy / ws };
    }
    const pull = 0.7;
    const at = pulled
      ? { x: home.x * (1 - pull) + pulled.x * pull, y: home.y * (1 - pull) + pulled.y * pull }
      : home;
    const wander =
      phase === 'gathering'
        ? s.bubble * 2.6
        : phase === 'candidates'
          ? s.bubble * 1.8
          : s.bubble * (pulled ? 0.7 : 1.4);
    bubbles[id] = { ...at, r: s.bubble, wander, opacity: 1 };
  });
  for (const b of vm.bubbles) {
    if (b.present) continue;
    // Out: float off the top and fade.
    bubbles[b.userId] = {
      x: size.w / 2,
      y: -s.bubble * 4,
      r: s.bubble * 0.7,
      wander: 0,
      opacity: 0,
    };
  }

  const consensus =
    merged.length >= 2 && clusterAt
      ? { members: merged, at: clusterAt, r: consensusR, absorbing: booked }
      : null;

  const doers: Layout['doers'] = {};
  if (settled) {
    // A recognizable, loose helper group around the plan; positions do not randomize.
    const reach = booked ? s.venue * 1.7 + s.doer * 1.65 : consensusR + s.doer * 1.3;
    const tilt = [-0.22, 0.15, -0.1, 0.18];
    const spread = [1, 1.08, 0.96, 1.04];
    DOER_KINDS.forEach((kind, i) => {
      const angle = -Math.PI / 3 + (i * Math.PI) / 2 + tilt[i]!;
      const at = {
        x: centre.x + Math.cos(angle) * reach * spread[i]!,
        y: centre.y + Math.sin(angle) * reach * spread[i]! * 0.85,
      };
      doers[kind] = {
        ...at,
        r: s.doer,
        wander: complete ? 0 : s.doer * 0.12,
        opacity: 1,
        ...(complete && leaderId ? { absorb: { venueId: leaderId, order: i } } : {}),
      };
    });
  }

  // Nothing visible ever targets past the screen edge.
  const fit = (t: Target) => {
    if (t.opacity === 0) return;
    const m = t.r + t.wander + 4;
    t.wander = Math.min(t.wander, Math.max(0, size.w / 2 - t.r - 8));
    t.x = clamp(t.x, Math.min(m, size.w / 2), Math.max(size.w - m, size.w / 2));
    t.y = clamp(t.y, t.r + 4, size.h - t.r - 4);
  };
  [...Object.values(venues), ...Object.values(bubbles), ...Object.values(doers)].forEach(fit);

  return { venues, bubbles, consensus, doers, doerOrigin: settled ? centre : null };
}
