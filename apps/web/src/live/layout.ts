/**
 * Where everything wants to be on a full-screen arena of any size. Pure: the force simulation
 * floats each node around its target with a `wander` radius that shrinks as the crew converges,
 * so bubbles drift freely while gathering and settle tight once they agree.
 */
import type { DoerKind } from '@bubbleworks/shared';
import { DOER_KINDS, type Phase, type ViewModel } from './view-model';

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
}

export interface Layout {
  venues: Record<string, Target & { leader: boolean; dim: boolean }>;
  bubbles: Record<string, Target>;
  /** Bubbles the consensus bubble wraps, and where it sits. */
  consensus: { members: string[]; at: Point; r: number } | null;
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

/** Space the overlay text leaves free. */
function safeArea(size: Size, sheet: boolean) {
  const top = 112;
  const bottom = sheet ? 170 : 40;
  return { top, bottom: size.h - bottom, height: size.h - bottom - top };
}

/** Deterministic, organic-looking spread over a region (golden-angle spiral). */
function spiral(i: number, n: number, c: Point, rx: number, ry: number): Point {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const t = Math.sqrt((i + 0.5) / Math.max(n, 1));
  return { x: c.x + Math.cos(i * golden) * rx * t, y: c.y + Math.sin(i * golden) * ry * t };
}

export function computeLayout(vm: ViewModel, phase: Phase, size: Size): Layout {
  const s = sizes(size);
  const settled = phase === 'locked' || phase === 'summary';
  const area = safeArea(size, settled || phase === 'closed');
  const span = Math.min(size.w * 0.84, 960);
  const left = (size.w - span) / 2;
  const centre: Point = { x: size.w / 2, y: area.top + area.height * (settled ? 0.58 : 0.6) };

  // Venues float across the top band in two staggered rows.
  const live = vm.venues;
  const leaderId = vm.locked?.venue.venueId ?? vm.merged?.venueId ?? vm.leaderVenueId;
  const slot: Record<string, Point> = {};
  live.forEach((v, i) => {
    const n = live.length;
    slot[v.venueId] = {
      x: n === 1 ? size.w / 2 : left + s.venue + (i * (span - 2 * s.venue)) / (n - 1),
      y: area.top + s.venue + (i % 2 === 0 ? 0 : s.venue * 2.9),
    };
  });
  const venues: Layout['venues'] = {};
  for (const v of live) {
    const chosen = v.venueId === leaderId;
    const gone = v.eliminated || (settled && !chosen);
    const at =
      settled && chosen ? { x: size.w / 2, y: area.top + s.venue * 1.1 } : slot[v.venueId]!;
    venues[v.venueId] = {
      ...at,
      y: gone ? -s.venue * 3 : at.y,
      r: chosen && (vm.merged || settled) ? s.venue * 1.25 : s.venue,
      wander: gone ? 0 : settled ? s.venue * 0.15 : s.venue * 0.35,
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
  present.forEach((id, i) => {
    const home = spiral(i, present.length, centre, roam.x, roam.y);
    const k = merged.indexOf(id);
    if (k >= 0 && clusterAt) {
      // Packed inside the consensus bubble.
      const ring = merged.length === 1 ? 0 : consensusR - inside * 1.25;
      const a = (k / merged.length) * Math.PI * 2 - Math.PI / 2;
      bubbles[id] = {
        x: clusterAt.x + Math.cos(a) * ring * 0.85,
        y: clusterAt.y + Math.sin(a) * ring * 0.85,
        r: inside,
        wander: s.bubble * 0.12,
        opacity: 1,
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
    merged.length >= 2 && clusterAt ? { members: merged, at: clusterAt, r: consensusR } : null;

  const doers: Layout['doers'] = {};
  if (settled) {
    const ring = consensusR + s.doer * 1.7;
    DOER_KINDS.forEach((kind, i) => {
      const a = -Math.PI / 4 - (i * Math.PI) / 2;
      doers[kind] = {
        x: centre.x + Math.cos(a) * ring * 1.1,
        y: centre.y - Math.sin(a) * ring * 0.92,
        r: s.doer,
        wander: s.doer * 0.12,
        opacity: 1,
      };
    });
  }

  // Nothing visible ever targets past the screen edge.
  const fit = (t: Target) => {
    if (t.opacity === 0) return;
    t.x = clamp(t.x, t.r + 4, size.w - t.r - 4);
    t.y = clamp(t.y, t.r + 4, size.h - t.r - 4);
  };
  [...Object.values(venues), ...Object.values(bubbles), ...Object.values(doers)].forEach(fit);

  return { venues, bubbles, consensus, doers, doerOrigin: settled ? centre : null };
}
