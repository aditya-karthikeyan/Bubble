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
  /** Fly into this node (`CREW` or `venueNode(id)`) and get absorbed, in this order. */
  absorb?: { into: string; order: number };
  /** Ruled out or finished: pop in place, after this many staggers. */
  pop?: number;
}

/** Node ids the arena uses, so absorb targets can name them. */
export const CREW = 'crew';
export const venueNode = (venueId: string) => `v:${venueId}`;

export interface Layout {
  venues: Record<string, Target & { leader: boolean; dim: boolean }>;
  bubbles: Record<string, Target>;
  /** Bubbles the consensus bubble wraps, and where it sits. */
  consensus: { members: string[]; at: Point; r: number; absorbing: boolean } | null;
  /**
   * Once the place is decided, everyone is absorbed into this one crew bubble, which carries
   * their names (in absorb order). It is absorbed into the destination once booked.
   */
  crew: (Target & { members: string[] }) | null;
  doers: Partial<Record<DoerKind, Target>>;
  /** Where doers are born when they split off: the consensus centre. */
  doerOrigin: Point | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Radii scale with the screen, within readable bounds. */
export function sizes(size: Size) {
  if (floatingWindows(size)) {
    // Desktop: the windows float over the arena, so the bubbles get the whole screen.
    const m = Math.min(size.w * 0.62, size.h);
    return {
      bubble: clamp(m / 15, 30, 64),
      venue: clamp(m / 14, 32, 70),
      doer: clamp(m / 14, 36, 66),
    };
  }
  const m = Math.min(size.w, size.h * 0.7);
  return {
    bubble: clamp(m / 13, 24, 40),
    venue: clamp(m / 14, 24, 44),
    doer: clamp(m / 11, 30, 48),
  };
}

/** A landscape phone: the windows stack in a column on the left instead (see globals.css). */
export const sideWindows = (size: Size) => size.h <= 500 && size.w >= 640;
/** Desktop: windows pop up anywhere and can be dragged; phones keep them docked. */
export const floatingWindows = (size: Size) => size.w > 760 && size.h > 500;

/**
 * Space the window chrome leaves free: the plan window on top, the taskbar below, and the
 * booking dialog above the taskbar once the plan settles. Below 760px tall (a phone with its
 * browser toolbars showing, a short laptop) the windows go compact; see globals.css.
 */
export function safeArea(size: Size, sheet: boolean) {
  if (floatingWindows(size)) {
    const bottom = size.h - 58;
    return { left: 0, right: size.w, width: size.w, top: 16, bottom, height: bottom - 16 };
  }
  if (sideWindows(size)) {
    const left = 320;
    const bottom = size.h - 58;
    return { left, right: size.w, width: size.w - left, top: 12, bottom, height: bottom - 12 };
  }
  const short = size.h < 760;
  const top = short ? (size.w <= 760 ? 164 : 150) : size.w <= 760 ? 204 : 196;
  const bottom = size.h - (sheet ? (short ? 186 : 250) : 64);
  return { left: 0, right: size.w, width: size.w, top, bottom, height: bottom - top };
}

/** How far each free bubble leans toward the rest of the crew. */
const COHESION = 0.4;

/** The doer ring around the hub: fixed angles and distances, so the group reads the same each time. */
const TILT = [-0.22, 0.15, -0.1, 0.18];
const SPREAD = [1, 1.08, 0.96, 1.04];
const ringAngle = (i: number) => -Math.PI / 3 + (i * Math.PI) / 2 + TILT[i]!;

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
  const span = area.width * (floatingWindows(size) ? 0.8 : 0.84);
  const cx = area.left + area.width / 2;

  // Settled: a hub (the crew, then the destination once booked) with the doers in a ring around
  // it. On short screens the whole group shrinks to fit between the windows.
  const squash = 0.85;
  const people = vm.bubbles.filter((b) => b.present).length;
  const crewFull = clamp(s.bubble * (1.25 + 0.22 * people), s.bubble * 1.5, s.bubble * 2.6);
  const hubFull = complete ? s.venue * 2.4 : booked ? s.venue * 1.7 : crewFull;
  const reachFull = (booked ? s.venue * 1.7 : crewFull) + s.doer * 1.65;
  const groupTop = settled && !booked ? area.top + s.venue * 3.2 : area.top;
  const room = area.bottom - groupTop;
  const ringExtent = (sign: number) =>
    Math.max(...DOER_KINDS.map((_, i) => sign * Math.sin(ringAngle(i)) * SPREAD[i]! * squash));
  const above = Math.max(hubFull, ringExtent(-1) * reachFull + s.doer * 1.1);
  const below = Math.max(hubFull * (booked ? 2 : 1.4), ringExtent(1) * reachFull + s.doer * 1.6);
  const fitK = settled ? clamp(room / (above + below), 0.55, 1) : 1;
  const centre: Point = settled
    ? { x: cx, y: groupTop + above * fitK + Math.max(0, room - (above + below) * fitK) / 2 }
    : { x: cx, y: area.top + area.height * 0.6 };

  // No rows or fixed slots: each venue has its own random anchor in the upper arena.
  const live = vm.venues;
  const leaderId = vm.locked?.venue.venueId ?? vm.merged?.venueId ?? vm.leaderVenueId;
  const slot: Record<string, Point> = {};
  live.forEach((v) => {
    slot[v.venueId] = point(
      `venue:${v.venueId}`,
      { x: cx, y: area.top + s.venue * 3.1 },
      Math.max(0, span / 2 - s.venue * 1.5),
      s.venue * 1.15,
    );
  });
  const venues: Layout['venues'] = {};
  let popped = 0;
  for (const v of live) {
    const chosen = v.venueId === leaderId;
    const gone = v.eliminated || (settled && !chosen);
    // The chosen place waits on top while locked, then becomes the hero at the centre once booked.
    const at =
      booked && chosen
        ? { ...centre }
        : settled && chosen
          ? { x: cx, y: area.top + s.venue * 1.1 }
          : slot[v.venueId]!;
    venues[v.venueId] = {
      ...at,
      r:
        complete && chosen
          ? s.venue * 2.4 * fitK
          : booked && chosen
            ? s.venue * 1.7 * fitK
            : chosen && (vm.merged || settled)
              ? s.venue * 1.25
              : s.venue,
      wander: gone ? 0 : settled ? s.venue * 0.15 : s.venue * 0.9,
      opacity: gone ? 0 : 1,
      leader: chosen,
      dim: gone,
      ...(gone ? { pop: popped++ } : {}),
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
    clusterAt.x = clamp(clusterAt.x, area.left + consensusR + 8, area.right - consensusR - 8);
  }

  const bubbles: Layout['bubbles'] = {};
  const free: string[] = [];
  const roam = { x: area.width * 0.36, y: area.height * 0.3 };
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
        wander: settled ? 0 : room * 0.45,
        opacity: 1,
        ...(settled ? { absorb: { into: CREW, order: k } } : {}),
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
    free.push(id);
  });
  // Keep the crew a loose flock: each free bubble leans toward the others, so nobody's own
  // favourite place strands them across the screen alone.
  if (free.length > 1) {
    const mx = free.reduce((t, id) => t + bubbles[id]!.x, 0) / free.length;
    const my = free.reduce((t, id) => t + bubbles[id]!.y, 0) / free.length;
    for (const id of free) {
      const b = bubbles[id]!;
      b.x += (mx - b.x) * COHESION;
      b.y += (my - b.y) * COHESION;
    }
  }
  for (const b of vm.bubbles) {
    if (b.present) continue;
    // Out: float off the top and fade.
    bubbles[b.userId] = {
      x: cx,
      y: -s.bubble * 4,
      r: s.bubble * 0.7,
      wander: 0,
      opacity: 0,
    };
  }

  const consensus =
    merged.length >= 2 && clusterAt
      ? { members: merged, at: clusterAt, r: consensusR, absorbing: settled }
      : null;

  const crewR = crewFull * fitK;
  const crew: Layout['crew'] =
    settled && merged.length > 0
      ? {
          ...centre,
          r: crewR,
          wander: booked ? 0 : s.bubble * 0.5,
          opacity: 1,
          members: merged,
          ...(booked && leaderId ? { absorb: { into: venueNode(leaderId), order: 0 } } : {}),
        }
      : null;

  const doers: Layout['doers'] = {};
  if (settled) {
    // A recognizable, loose helper group around the plan; positions do not randomize.
    const reach = reachFull * fitK;
    DOER_KINDS.forEach((kind, i) => {
      const angle = ringAngle(i);
      const at = {
        x: centre.x + Math.cos(angle) * reach * SPREAD[i]!,
        y: centre.y + Math.sin(angle) * reach * SPREAD[i]! * squash,
      };
      // A helper that finishes pops; whoever is still at it once the plan completes (the
      // Watcher) goes into the destination with everything else.
      const done = vm.doers[kind]?.state === 'done';
      doers[kind] = {
        ...at,
        r: s.doer * fitK,
        wander: complete ? 0 : s.doer * 0.12,
        opacity: done ? 0 : 1,
        ...(done
          ? { pop: 0 }
          : complete && leaderId
            ? { absorb: { into: venueNode(leaderId), order: i } }
            : {}),
      };
    });
  }

  // Nothing visible ever targets past the edge of the arena.
  const fit = (t: Target) => {
    if (t.opacity === 0) return;
    const m = t.r + t.wander + 4;
    t.wander = Math.min(t.wander, Math.max(0, area.width / 2 - t.r - 8));
    t.x = clamp(t.x, Math.min(area.left + m, cx), Math.max(area.right - m, cx));
    t.y = clamp(t.y, t.r + 4, size.h - t.r - 4);
  };
  [
    ...Object.values(venues),
    ...Object.values(bubbles),
    ...Object.values(doers),
    ...(crew ? [crew] : []),
  ].forEach(fit);

  return { venues, bubbles, consensus, crew, doers, doerOrigin: settled ? centre : null };
}
