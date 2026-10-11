/**
 * Where everything wants to be, in a fixed 400 x 560 arena (the SVG scales it to the screen).
 * Pure: the force simulation pulls bubbles toward these targets; venues and doers sit on them.
 */
import type { DoerKind } from '@bubbleworks/shared';
import { DOER_KINDS, type Phase, type ViewModel } from './view-model';

export const W = 400;
export const H = 560;
export const BUBBLE_R = 26;
export const VENUE_R = 30;
export const DOER_R = 34;
export const CENTER = { x: W / 2, y: H * 0.64 } as const;

export interface Point {
  x: number;
  y: number;
}

export interface Layout {
  venues: Record<string, Point & { r: number; dim: boolean; leader: boolean }>;
  bubbles: Record<string, Point>;
  consensus: (Point & { r: number }) | null;
  doers: Partial<Record<DoerKind, Point>>;
}

/** Venues along two staggered rows at the top. */
function venueSlots(ids: string[]): Record<string, Point> {
  const out: Record<string, Point> = {};
  const n = ids.length;
  ids.forEach((id, i) => {
    const x = n === 1 ? W / 2 : 62 + (i * (W - 124)) / (n - 1);
    out[id] = { x, y: i % 2 === 0 ? 92 : 152 };
  });
  return out;
}

/** People in a loose row near the bottom while they gather. */
function homeSlots(ids: string[], y: number): Record<string, Point> {
  const out: Record<string, Point> = {};
  const n = ids.length;
  ids.forEach((id, i) => {
    out[id] = { x: n === 1 ? W / 2 : 56 + (i * (W - 112)) / (n - 1), y: y + (i % 2) * 34 };
  });
  return out;
}

export function computeLayout(vm: ViewModel, phase: Phase): Layout {
  const venueIds = vm.venues.map((v) => v.venueId);
  const slots = venueSlots(venueIds);
  const leader = vm.locked?.venue.venueId ?? vm.merged?.venueId ?? vm.leaderVenueId;
  const venues: Layout['venues'] = {};
  for (const v of vm.venues) {
    const slot = slots[v.venueId]!;
    const chosen = v.venueId === leader;
    const settled = phase === 'locked' || phase === 'summary';
    venues[v.venueId] = {
      ...slot,
      r:
        v.eliminated || (settled && !chosen)
          ? VENUE_R * 0.6
          : chosen && vm.merged
            ? VENUE_R * 1.2
            : VENUE_R,
      dim: v.eliminated || (settled && !chosen),
      leader: chosen,
    };
  }

  const present = vm.bubbles.filter((b) => b.present).map((b) => b.userId);
  const home = homeSlots(present, phase === 'gathering' ? 400 : 430);
  const bubbles: Layout['bubbles'] = {};
  for (const b of vm.bubbles) {
    if (!b.present) {
      // Out: float off the top edge and fade.
      bubbles[b.userId] = { x: home[b.userId]?.x ?? W / 2, y: -80 };
      continue;
    }
    const h = home[b.userId]!;
    if (phase === 'locked' || phase === 'summary') {
      bubbles[b.userId] = CENTER;
      continue;
    }
    const mergedHere = vm.merged?.userIds.includes(b.userId) ? slots[vm.merged.venueId] : undefined;
    if (mergedHere) {
      bubbles[b.userId] = { x: mergedHere.x, y: mergedHere.y + 120 };
      continue;
    }
    const scores = vm.scores[b.userId];
    if (!scores) {
      bubbles[b.userId] = h;
      continue;
    }
    // Weighted pull toward each live venue, squared so a clear favorite wins.
    let wx = 0;
    let wy = 0;
    let wsum = 0;
    for (const v of vm.venues) {
      if (v.eliminated) continue;
      const s = scores[v.venueId] ?? 0;
      const w = s * s;
      wx += w * slots[v.venueId]!.x;
      wy += w * slots[v.venueId]!.y;
      wsum += w;
    }
    if (wsum === 0) {
      bubbles[b.userId] = h;
      continue;
    }
    const pull = 0.65;
    bubbles[b.userId] = {
      x: h.x * (1 - pull) + (wx / wsum) * pull,
      y: h.y * (1 - pull) + (wy / wsum + 110) * pull,
    };
  }

  let consensus: Layout['consensus'] = null;
  if (phase === 'locked' || phase === 'summary') {
    consensus = { ...CENTER, r: 36 + present.length * 5 };
  } else if (vm.merged) {
    const at = slots[vm.merged.venueId];
    if (at) consensus = { x: at.x, y: at.y + 120, r: 30 + vm.merged.userIds.length * 9 };
  }

  const doers: Layout['doers'] = {};
  if (phase === 'locked' || phase === 'summary') {
    const ring = 130;
    DOER_KINDS.forEach((kind, i) => {
      const a = -Math.PI / 2 + Math.PI / 4 + (i * Math.PI) / 2;
      doers[kind] = { x: CENTER.x + Math.cos(a) * ring, y: CENTER.y + Math.sin(a) * ring };
    });
  }

  return { venues, bubbles, consensus, doers };
}
