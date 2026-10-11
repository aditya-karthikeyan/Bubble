/**
 * Domain types. Owner: P1. Changes need P1 approval.
 * Every type is a zod schema first; the TypeScript type is inferred from the schema.
 */
import { z } from 'zod';

export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** Calendar date, YYYY-MM-DD, in the group's local timezone. */
export const IsoDate = z.iso.date();
export type IsoDate = z.infer<typeof IsoDate>;

export const GeoPoint = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type GeoPoint = z.infer<typeof GeoPoint>;

// ---------------------------------------------------------------------------
// Users and groups
// ---------------------------------------------------------------------------

export const User = z.object({
  id: z.string(),
  displayName: z.string(),
  /** Messaging identity: the person's phone in E.164, as Spectrum reports it. */
  handle: z.string(),
  email: z.string().nullable().default(null),
  /** Photon-assigned number the person texts to reach their bubble. Null until signup. */
  bubbleNumber: z.string().nullable().default(null),
  /** Set when the person has texted their bubble at least once (the adapter may then text them). */
  onboardedAt: IsoDateTime.nullable().default(null),
  timezone: z.string().default('America/New_York'),
  createdAt: IsoDateTime,
});
export type User = z.infer<typeof User>;

export const GroupStatus = z.enum(['pending', 'active']);
export type GroupStatus = z.infer<typeof GroupStatus>;

/**
 * A group is a crew: people who plan together. Photon cannot join iMessage group chats, so
 * every member talks to their own bubble over DM and the messaging adapter fans group messages
 * out to each member. chatId is therefore virtual: `crew:<groupId>` (see crewChatId()).
 */
export const Group = z.object({
  id: z.string(),
  name: z.string(),
  /** Virtual chat id, `crew:<groupId>`. The adapter resolves it to member DMs. */
  chatId: z.string(),
  /** pending until every named member has confirmed with their own bubble. */
  status: GroupStatus.default('pending'),
  createdByUserId: z.string().nullable().default(null),
  /** Center of the group's area, used for distance filters. */
  center: GeoPoint.nullable().default(null),
  timezone: z.string().default('America/New_York'),
  createdAt: IsoDateTime,
});
export type Group = z.infer<typeof Group>;

export const CREW_CHAT_PREFIX = 'crew:';
export function crewChatId(groupId: string): string {
  return `${CREW_CHAT_PREFIX}${groupId}`;
}
export function groupIdFromChatId(chatId: string): string | null {
  return chatId.startsWith(CREW_CHAT_PREFIX) ? chatId.slice(CREW_CHAT_PREFIX.length) : null;
}

export const GroupMember = z.object({
  groupId: z.string(),
  userId: z.string(),
  joinedAt: IsoDateTime,
  /** Null until the member confirmed membership with their own bubble. */
  confirmedAt: IsoDateTime.nullable().default(null),
});
export type GroupMember = z.infer<typeof GroupMember>;

// ---------------------------------------------------------------------------
// Facts (what a bubble knows about its person)
// ---------------------------------------------------------------------------

export const FactType = z.enum([
  'diet',
  'allergy',
  'religious_diet',
  'accessibility',
  'budget_max',
  'cuisine_like',
  'cuisine_avoid',
  'neighborhood',
  'favorite_venue',
  'venmo_handle',
  /** Any pay-back method, value "<kind>:<handle>": venmo:@x, cashapp:$x, zelle:+1555..., paypal:x */
  'payment_handle',
  'other',
]);
export type FactType = z.infer<typeof FactType>;

/** Fact types that are never relaxed and never the subject of a concession ask. */
export const NEVER_RELAX_FACT_TYPES: ReadonlySet<FactType> = new Set<FactType>([
  'allergy',
  'religious_diet',
  'accessibility',
]);

export const FactSource = z.enum(['onboarding', 'chat', 'reaction', 'manual']);
export type FactSource = z.infer<typeof FactSource>;

export const Fact = z.object({
  id: z.string(),
  userId: z.string(),
  type: FactType,
  /**
   * Normalized value. Conventions:
   * diet: vegetarian | vegan | pescatarian | gluten_free | dairy_free | no_pork | no_beef | no_red_meat
   * allergy: peanut | tree_nut | shellfish | dairy | gluten | soy | egg | sesame
   * religious_diet: halal | kosher | hindu_veg | jain
   * accessibility: wheelchair | step_free | quiet
   * budget_max: integer dollars per person as a string, e.g. "25"
   * cuisine_like / cuisine_avoid: lowercase cuisine key, e.g. "thai"
   * neighborhood: free text; favorite_venue: venue id; venmo_handle: "@name"
   * payment_handle: "venmo:@name" | "cashapp:$name" | "zelle:+15551234567" | "zelle:a@b.c" | "paypal:name"
   */
  value: z.string(),
  /** Hard facts filter candidates. Soft facts only score them. */
  hard: z.boolean(),
  confidence: z.number().min(0).max(1),
  source: FactSource,
  confirmed: z.boolean(),
  expiresAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type Fact = z.infer<typeof Fact>;

export const NewFact = Fact.omit({ id: true, createdAt: true }).extend({
  expiresAt: IsoDateTime.nullable().default(null),
});
export type NewFact = z.infer<typeof NewFact>;

export const Presence = z.enum(['available', 'focus', 'sleep', 'driving', 'unknown']);
export type Presence = z.infer<typeof Presence>;

export const BusyInterval = z.object({ start: IsoDateTime, end: IsoDateTime });
export type BusyInterval = z.infer<typeof BusyInterval>;

// ---------------------------------------------------------------------------
// Venues
// ---------------------------------------------------------------------------

/** Minutes since midnight, local time. A day with no interval is closed. */
export const OpenInterval = z.object({
  open: z.number().int().min(0).max(1440),
  close: z
    .number()
    .int()
    .min(0)
    .max(1440 + 6 * 60),
});
export type OpenInterval = z.infer<typeof OpenInterval>;

/** Index 0 is Sunday, matching Date.getDay(). */
export const WeeklyHours = z.array(z.array(OpenInterval)).length(7);
export type WeeklyHours = z.infer<typeof WeeklyHours>;

export const PriceLevel = z.number().int().min(1).max(4);
export type PriceLevel = z.infer<typeof PriceLevel>;

export const VenueStyle = z.enum(['sit_down', 'fast_food']);
export type VenueStyle = z.infer<typeof VenueStyle>;

export const Venue = z.object({
  id: z.string(),
  name: z.string(),
  /** Lowercase cuisine key, e.g. "thai", "pizza", "american". */
  cuisine: z.string(),
  /** Raw OSM cuisine values before folding, e.g. ["hot_dog"], ["burger", "breakfast"]. */
  cuisineTags: z.array(z.string()).optional(),
  /** Sit-down restaurant, or counter service / takeout (OSM fast_food and cafe). Absent = sit-down. */
  style: VenueStyle.optional(),
  /** Diet keys this venue can serve: vegetarian, vegan, halal, gluten_free, ... */
  dietTags: z.array(z.string()),
  /** Accessibility keys this venue satisfies: wheelchair, step_free. */
  accessibilityTags: z.array(z.string()).default([]),
  priceLevel: PriceLevel,
  /** Approximate dollars per person, derived from priceLevel when unknown. */
  typicalCostUsd: z.number().int().positive(),
  hours: WeeklyHours,
  /** E.164, e.g. +19195551234. */
  phone: z.string(),
  location: GeoPoint,
  address: z.string().nullable().default(null),
  neighborhood: z.string().nullable().default(null),
  /** The demo venue rings a teammate's phone. */
  isDemo: z.boolean().default(false),
});
export type Venue = z.infer<typeof Venue>;

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export const PlanState = z.enum([
  'IDLE',
  'DETECTED',
  'GATHERING',
  'DELIBERATING',
  'DEADLOCK',
  'LOCKED',
  'BOOKING',
  'BOOKED',
  'DAY_OF',
  'CLOSED',
  'CANCELLED',
  'FAILED',
  'PAUSED',
]);
export type PlanState = z.infer<typeof PlanState>;

export const MealKind = z.enum(['breakfast', 'brunch', 'lunch', 'dinner', 'drinks', 'coffee']);
export type MealKind = z.infer<typeof MealKind>;

export const PlanIntent = z.object({
  meal: MealKind,
  /** Local calendar date the plan is for. */
  date: IsoDate,
  /** Requested start, local minutes since midnight, when the message named one. */
  startMinutes: z.number().int().min(0).max(1440).nullable().default(null),
  /** Cuisine the message named, when it did. */
  cuisine: z.string().nullable().default(null),
  /** Style the message named ("takeout", "sit down"), when it did. Optional for older callers. */
  style: VenueStyle.nullish(),
  rawText: z.string(),
});
export type PlanIntent = z.infer<typeof PlanIntent>;

export const Plan = z.object({
  id: z.string(),
  groupId: z.string(),
  chatId: z.string(),
  state: PlanState,
  /** State to return to after PAUSED. */
  resumeState: PlanState.nullable().default(null),
  intent: PlanIntent,
  createdByUserId: z.string(),
  /** Spectrum message id of the message that started the plan, for thread scoping. */
  sourceMessageId: z.string().nullable().default(null),
  /** 128-bit random token for the live page URL /p/[token]. */
  pageToken: z.string(),
  pageTokenExpiresAt: IsoDateTime.nullable().default(null),
  chosenVenueId: z.string().nullable().default(null),
  backupVenueId: z.string().nullable().default(null),
  /** Chosen start time once known. */
  startAt: IsoDateTime.nullable().default(null),
  lockedAt: IsoDateTime.nullable().default(null),
  /** Per-member budget for this plan (PLAN_MESSAGE_BUDGET unless overridden). */
  messageBudget: z.number().int().nonnegative(),
  /** Running total across members, for logs and the speed report. */
  messagesUsed: z.number().int().nonnegative().default(0),
  demoMode: z.boolean().default(false),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: IsoDateTime.nullable().default(null),
});
export type Plan = z.infer<typeof Plan>;

export const PlanMemberStatus = z.enum(['invited', 'in', 'out', 'represented', 'dropped']);
export type PlanMemberStatus = z.infer<typeof PlanMemberStatus>;

export const PlanMember = z.object({
  planId: z.string(),
  userId: z.string(),
  status: PlanMemberStatus,
  /** Set when the bubble answers for an absent member within confirmed hard limits. */
  representedByBubble: z.boolean().default(false),
  /** Messages sent to this member for this plan. The budget (PLAN_MESSAGE_BUDGET) is per member. */
  messagesUsed: z.number().int().nonnegative().default(0),
  joinedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PlanMember = z.infer<typeof PlanMember>;

/** What the live page may show about a bubble. Nothing else about a member leaves the server. */
export const BubblePageStatus = z.enum(['fits', 'stretching', 'holding_firm', 'represented']);
export type BubblePageStatus = z.infer<typeof BubblePageStatus>;

// ---------------------------------------------------------------------------
// Votes, asks, bookings, ledger
// ---------------------------------------------------------------------------

export const PollKind = z.enum(['cuisine', 'headcount', 'time', 'venue', 'style']);
export type PollKind = z.infer<typeof PollKind>;

export const Vote = z.object({
  id: z.string(),
  planId: z.string(),
  pollId: z.string(),
  kind: PollKind,
  userId: z.string(),
  /** Option key as sent in the poll. For headcount: "in" | "out". */
  choice: z.string(),
  at: IsoDateTime,
});
export type Vote = z.infer<typeof Vote>;

export const AskKind = z.enum(['budget', 'distance', 'time', 'deposit', 'seat', 'represent']);
export type AskKind = z.infer<typeof AskKind>;

export const AskStatus = z.enum(['pending', 'accepted', 'declined', 'expired', 'cancelled']);
export type AskStatus = z.infer<typeof AskStatus>;

/** A private question to one member. Contents never reach the page or the group. */
export const Ask = z.object({
  id: z.string(),
  planId: z.string(),
  userId: z.string(),
  kind: AskKind,
  /** Concession this ask proposes, e.g. budget 25 -> 30. Null for deposit/seat/represent asks. */
  concession: z
    .object({
      factType: FactType,
      from: z.string(),
      to: z.string(),
      /** size * (1 + recent compromise count) */
      cost: z.number().nonnegative(),
    })
    .nullable()
    .default(null),
  /** Text sent to the member, kept for "why" and audit only. */
  text: z.string(),
  status: AskStatus,
  idempotencyKey: z.string(),
  sentAt: IsoDateTime,
  expiresAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable().default(null),
});
export type Ask = z.infer<typeof Ask>;

export const BookingStatus = z.enum([
  'pending',
  'dialing',
  'in_call',
  'booked',
  'needs_human',
  'failed',
  'modified',
  'cancelled',
]);
export type BookingStatus = z.infer<typeof BookingStatus>;

export const Booking = z.object({
  id: z.string(),
  planId: z.string(),
  venueId: z.string(),
  backupVenueId: z.string().nullable().default(null),
  status: BookingStatus,
  partySize: z.number().int().positive(),
  startAt: IsoDateTime,
  /** Name the reservation is under. */
  reservationName: z.string(),
  confirmationCode: z.string().nullable().default(null),
  /** Caller's call id, when a call happened. */
  callId: z.string().nullable().default(null),
  /** True when the venue asked for a deposit or card. Needs a human tap. */
  depositRequested: z.boolean().default(false),
  notes: z.string().nullable().default(null),
  idempotencyKey: z.string(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Booking = z.infer<typeof Booking>;

export const LedgerKind = z.enum(['compromised', 'got_preference', 'organized', 'paid', 'absent']);
export type LedgerKind = z.infer<typeof LedgerKind>;

/** Fairness ledger. One row per member per plan outcome. Owner: P3 writes, P1 reads for scoring. */
export const LedgerEntry = z.object({
  id: z.string(),
  groupId: z.string(),
  planId: z.string(),
  userId: z.string(),
  kind: LedgerKind,
  /** Magnitude in the kind's unit: dollars for paid, concession cost otherwise, 1 for flags. */
  amount: z.number(),
  note: z.string().nullable().default(null),
  at: IsoDateTime,
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;
