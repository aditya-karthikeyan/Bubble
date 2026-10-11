/**
 * Live page view model. A pure reducer over PlanEvents (live socket or fixture replay) and the
 * page phase derived from it. Only page-safe fields ever reach here: names, venue names,
 * statuses, normalized scores. Never budgets, distances, diets, or ask contents.
 */
import type {
  BubblePageStatus,
  DoerKind,
  DoerState,
  PageVenue,
  PlanEvent,
  PlanState,
} from '@bubbleworks/shared';

export type Phase =
  | 'gathering'
  | 'candidates'
  | 'convergence'
  | 'deadlock'
  | 'locked'
  | 'summary'
  | 'complete'
  | 'closed';

export const DOER_KINDS: readonly DoerKind[] = ['caller', 'inviter', 'splitter', 'watcher'];

export interface BubbleVM {
  userId: string;
  displayName: string;
  status: BubblePageStatus;
  /** False once the person is out or dropped; the bubble floats away. */
  present: boolean;
}

export interface VenueVM extends PageVenue {
  eliminated: boolean;
}

export interface DoerVM {
  kind: DoerKind;
  state: DoerState;
  detail: string | null;
}

export interface ViewModel {
  planState: PlanState | null;
  bubbles: BubbleVM[];
  venues: VenueVM[];
  /** Latest round: userId -> venueId -> 0..1. */
  scores: Record<string, Record<string, number>>;
  round: number;
  leaderVenueId: string | null;
  merged: { userIds: string[]; venueId: string } | null;
  openAsks: string[];
  locked: { venue: PageVenue; backup: PageVenue | null; startAt: string; partySize: number } | null;
  doers: Partial<Record<DoerKind, DoerVM>>;
  booking: { venue: PageVenue; startAt: string; partySize: number; reservationName: string } | null;
  closedReason: Extract<PlanEvent, { type: 'plan_closed' }>['reason'] | null;
  lastSeq: number;
}

export const EMPTY: ViewModel = {
  planState: null,
  bubbles: [],
  venues: [],
  scores: {},
  round: 0,
  leaderVenueId: null,
  merged: null,
  openAsks: [],
  locked: null,
  doers: {},
  booking: null,
  closedReason: null,
  lastSeq: 0,
};

function upsertBubble(list: BubbleVM[], b: Omit<BubbleVM, 'present'>): BubbleVM[] {
  const i = list.findIndex((x) => x.userId === b.userId);
  if (i < 0) return [...list, { ...b, present: true }];
  const next = [...list];
  next[i] = { ...next[i]!, ...b, present: true };
  return next;
}

export function reduce(vm: ViewModel, e: PlanEvent): ViewModel {
  // Replays and live events overlap on reconnect; seq makes the reducer idempotent.
  if (e.seq !== undefined && e.seq <= vm.lastSeq) return vm;
  const next: ViewModel = { ...vm, lastSeq: e.seq ?? vm.lastSeq };
  switch (e.type) {
    case 'plan_state_changed':
      return { ...next, planState: e.to };
    case 'bubble_joined':
      return { ...next, bubbles: upsertBubble(vm.bubbles, e.bubble) };
    case 'bubble_left':
      return {
        ...next,
        bubbles: vm.bubbles.map((b) => (b.userId === e.userId ? { ...b, present: false } : b)),
      };
    case 'candidate_added':
      return vm.venues.some((v) => v.venueId === e.venue.venueId)
        ? next
        : { ...next, venues: [...vm.venues, { ...e.venue, eliminated: false }] };
    case 'round_complete': {
      const scores: ViewModel['scores'] = {};
      for (const s of e.scores) (scores[s.userId] ??= {})[s.venueId] = s.score;
      let bubbles = vm.bubbles;
      for (const b of e.bubbles) bubbles = upsertBubble(bubbles, b);
      return { ...next, scores, round: e.round, leaderVenueId: e.leaderVenueId, bubbles };
    }
    case 'candidate_eliminated':
      return {
        ...next,
        venues: vm.venues.map((v) => (v.venueId === e.venueId ? { ...v, eliminated: true } : v)),
      };
    case 'bubble_merged':
      return { ...next, merged: { userIds: e.userIds, venueId: e.venueId } };
    case 'private_ask_sent':
      return vm.openAsks.includes(e.askId)
        ? next
        : { ...next, openAsks: [...vm.openAsks, e.askId] };
    case 'private_ask_resolved':
      return { ...next, openAsks: vm.openAsks.filter((a) => a !== e.askId) };
    case 'plan_locked':
      return {
        ...next,
        locked: { venue: e.venue, backup: e.backup, startAt: e.startAt, partySize: e.partySize },
        leaderVenueId: e.venue.venueId,
      };
    case 'doer_status':
      return {
        ...next,
        doers: {
          ...vm.doers,
          [e.doer]: { kind: e.doer, state: e.state, detail: e.detail ?? null },
        },
      };
    case 'booking_confirmed':
      return {
        ...next,
        booking: {
          venue: e.venue,
          startAt: e.startAt,
          partySize: e.partySize,
          reservationName: e.reservationName,
        },
      };
    case 'plan_closed':
      return { ...next, closedReason: e.reason };
  }
}

export function reduceAll(events: readonly PlanEvent[], from: ViewModel = EMPTY): ViewModel {
  return events.reduce(reduce, from);
}

/** The six visual phases (plus closed), derived so a late joiner lands on the right one. */
const FINISHED: readonly DoerState[] = ['done', 'failed', 'needs_human'];

/**
 * Booked and the follow-up doers (invites, split) have finished. The watcher keeps watching for
 * the rest of the night, so it never counts.
 */
export function planComplete(vm: ViewModel): boolean {
  if (!vm.booking) return false;
  return (['caller', 'inviter', 'splitter'] as const).every((k) => {
    const d = vm.doers[k];
    return d !== undefined && FINISHED.includes(d.state);
  });
}

export function phaseOf(vm: ViewModel): Phase {
  if (vm.closedReason && vm.closedReason !== 'completed' && !vm.booking) return 'closed';
  if (planComplete(vm)) return 'complete';
  if (vm.booking || vm.planState === 'BOOKED' || vm.planState === 'DAY_OF') return 'summary';
  if (vm.planState === 'CLOSED') return vm.booking ? 'summary' : 'closed';
  if (vm.locked || vm.planState === 'LOCKED' || vm.planState === 'BOOKING') return 'locked';
  if (vm.planState === 'DEADLOCK' || vm.openAsks.length > 0) return 'deadlock';
  if (vm.round > 0 || vm.merged) return 'convergence';
  if (vm.venues.length > 0) return 'candidates';
  return 'gathering';
}

export const PHASE_COPY: Record<Phase, { title: string; line: string }> = {
  gathering: { title: 'Gathering', line: 'Bubbles are joining the plan.' },
  candidates: { title: 'Finding places', line: 'Places that work for everyone are floating in.' },
  convergence: {
    title: 'Deliberating',
    line: 'Each bubble drifts toward the places that fit it best.',
  },
  deadlock: { title: 'Working it out', line: 'One private question is out. No one else sees it.' },
  locked: { title: 'Locked', line: 'The crew agreed. The doers are on it.' },
  summary: { title: 'Booked', line: 'Table secured. Wrapping up the details.' },
  complete: { title: 'Plan complete', line: 'Everything is sorted. See you there.' },
  closed: { title: 'Plan closed', line: 'This plan ended without a booking.' },
};

export const STATUS_LABEL: Record<BubblePageStatus, string> = {
  fits: 'fits',
  stretching: 'stretching',
  holding_firm: 'holding firm',
  represented: 'represented',
};
