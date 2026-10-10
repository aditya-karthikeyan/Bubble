/**
 * Event contract. Owner: P1. Changes need P1 approval.
 *
 * Every event is page-visible: the server broadcasts it to the live page room for the plan
 * and persists it for replay. Payloads therefore never contain budgets, distances, diets,
 * ask contents, or anything else that reveals one person's constraint. Bubble status on the
 * page is only fits, stretching, holding_firm, or represented.
 */
import { z } from 'zod';
import { BubblePageStatus, IsoDateTime, PlanState } from './types.js';

export const EVENT_TYPES = [
  'plan_state_changed',
  'bubble_joined',
  'bubble_left',
  'candidate_added',
  'round_complete',
  'candidate_eliminated',
  'bubble_merged',
  'private_ask_sent',
  'private_ask_resolved',
  'plan_locked',
  'doer_status',
  'booking_confirmed',
  'plan_closed',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

const base = {
  planId: z.string(),
  /** ISO time the event happened. */
  at: IsoDateTime,
  /** Monotonic per plan, assigned by the EventBus on publish. Absent before publish. */
  seq: z.number().int().nonnegative().optional(),
};

/** Public shape of a bubble on the page. displayName is first name or nickname only. */
export const PageBubble = z.object({
  userId: z.string(),
  displayName: z.string(),
  status: BubblePageStatus,
});
export type PageBubble = z.infer<typeof PageBubble>;

/** Public shape of a venue on the page. */
export const PageVenue = z.object({
  venueId: z.string(),
  name: z.string(),
  cuisine: z.string(),
});
export type PageVenue = z.infer<typeof PageVenue>;

export const DoerKind = z.enum(['caller', 'inviter', 'splitter', 'watcher']);
export type DoerKind = z.infer<typeof DoerKind>;

export const DoerState = z.enum(['started', 'working', 'done', 'failed', 'needs_human']);
export type DoerState = z.infer<typeof DoerState>;

export const PlanStateChanged = z.object({
  type: z.literal('plan_state_changed'),
  ...base,
  from: PlanState,
  to: PlanState,
  reason: z.string().optional(),
});

export const BubbleJoined = z.object({
  type: z.literal('bubble_joined'),
  ...base,
  bubble: PageBubble,
});

export const BubbleLeft = z.object({
  type: z.literal('bubble_left'),
  ...base,
  userId: z.string(),
  reason: z.enum(['out', 'dropped', 'left_group']),
});

export const CandidateAdded = z.object({
  type: z.literal('candidate_added'),
  ...base,
  venue: PageVenue,
});

/** One solver round. Scores are normalized 0..1 per bubble so the page can animate drift. */
export const RoundComplete = z.object({
  type: z.literal('round_complete'),
  ...base,
  round: z.number().int().positive(),
  scores: z.array(
    z.object({
      userId: z.string(),
      venueId: z.string(),
      score: z.number().min(0).max(1),
    }),
  ),
  bubbles: z.array(PageBubble),
  leaderVenueId: z.string().nullable(),
});

export const CandidateEliminated = z.object({
  type: z.literal('candidate_eliminated'),
  ...base,
  venueId: z.string(),
  round: z.number().int().positive(),
  reason: z.enum(['least_support', 'infeasible', 'closed', 'vetoed']),
});

/** Bubbles that now agree on one venue merge into a consensus bubble. */
export const BubbleMerged = z.object({
  type: z.literal('bubble_merged'),
  ...base,
  userIds: z.array(z.string()).min(2),
  venueId: z.string(),
});

/** Only the fact that an ask exists. Never who, never what. */
export const PrivateAskSent = z.object({
  type: z.literal('private_ask_sent'),
  ...base,
  askId: z.string(),
});

export const PrivateAskResolved = z.object({
  type: z.literal('private_ask_resolved'),
  ...base,
  askId: z.string(),
  outcome: z.enum(['accepted', 'declined', 'expired', 'cancelled']),
});

export const PlanLocked = z.object({
  type: z.literal('plan_locked'),
  ...base,
  venue: PageVenue,
  backup: PageVenue.nullable(),
  startAt: IsoDateTime,
  partySize: z.number().int().positive(),
});

export const DoerStatus = z.object({
  type: z.literal('doer_status'),
  ...base,
  doer: DoerKind,
  state: DoerState,
  /** Short, safe, page-visible line, e.g. "Dialing", "Line busy, trying backup". */
  detail: z.string().max(120).optional(),
});

export const BookingConfirmed = z.object({
  type: z.literal('booking_confirmed'),
  ...base,
  bookingId: z.string(),
  venue: PageVenue,
  startAt: IsoDateTime,
  partySize: z.number().int().positive(),
  reservationName: z.string(),
});

export const PlanClosed = z.object({
  type: z.literal('plan_closed'),
  ...base,
  reason: z.enum(['completed', 'cancelled', 'failed', 'too_few', 'expired']),
});

export const PlanEvent = z.discriminatedUnion('type', [
  PlanStateChanged,
  BubbleJoined,
  BubbleLeft,
  CandidateAdded,
  RoundComplete,
  CandidateEliminated,
  BubbleMerged,
  PrivateAskSent,
  PrivateAskResolved,
  PlanLocked,
  DoerStatus,
  BookingConfirmed,
  PlanClosed,
]);
export type PlanEvent = z.infer<typeof PlanEvent>;

export type PlanEventOf<T extends EventType> = Extract<PlanEvent, { type: T }>;

/** Validate an inbound event (socket, webhook, replay). Throws ZodError on mismatch. */
export function parsePlanEvent(input: unknown): PlanEvent {
  return PlanEvent.parse(input);
}

/** Non-throwing variant for handlers that tolerate junk. */
export function safeParsePlanEvent(input: unknown): PlanEvent | null {
  const result = PlanEvent.safeParse(input);
  return result.success ? result.data : null;
}

/** Keys that must never appear anywhere in a page-visible payload. Enforced by a test. */
export const FORBIDDEN_PAYLOAD_KEYS = [
  'budget',
  'budgetMax',
  'budget_max',
  'distance',
  'distanceMin',
  'diet',
  'allergy',
  'religious_diet',
  'accessibility',
  'facts',
  'text',
  'concession',
  'location',
  'lat',
  'lng',
] as const;
