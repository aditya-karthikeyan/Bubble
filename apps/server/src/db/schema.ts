/**
 * Drizzle schema for the server's SQLite database. Owner: P1.
 *
 * Conventions: ids are text (see newId in @bubbleworks/shared), timestamps are ISO-8601 text
 * except timers.fire_at which is epoch milliseconds for cheap range scans, booleans are
 * integers in boolean mode, and structured columns are JSON text typed with $type.
 */
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type {
  AskKind,
  AskStatus,
  BookingStatus,
  FactSource,
  FactType,
  GroupStatus,
  LedgerKind,
  OpenInterval,
  PlanIntent,
  PlanMemberStatus,
  PlanState,
  PollKind,
  VenueStyle,
} from '@bubbleworks/shared';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  handle: text('handle').notNull().unique(),
  email: text('email'),
  bubbleNumber: text('bubble_number'),
  onboardedAt: text('onboarded_at'),
  timezone: text('timezone').notNull().default('America/New_York'),
  createdAt: text('created_at').notNull(),
});

export const facts = sqliteTable(
  'facts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<FactType>().notNull(),
    value: text('value').notNull(),
    hard: integer('hard', { mode: 'boolean' }).notNull(),
    confidence: real('confidence').notNull(),
    source: text('source').$type<FactSource>().notNull(),
    confirmed: integer('confirmed', { mode: 'boolean' }).notNull(),
    expiresAt: text('expires_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('facts_user_idx').on(t.userId)],
);

export const groups = sqliteTable('groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  chatId: text('chat_id').notNull().unique(),
  status: text('status').$type<GroupStatus>().notNull().default('pending'),
  createdByUserId: text('created_by_user_id'),
  centerLat: real('center_lat'),
  centerLng: real('center_lng'),
  timezone: text('timezone').notNull().default('America/New_York'),
  createdAt: text('created_at').notNull(),
});

export const groupMembers = sqliteTable(
  'group_members',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: text('joined_at').notNull(),
    confirmedAt: text('confirmed_at'),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

export const plans = sqliteTable(
  'plans',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id),
    chatId: text('chat_id').notNull(),
    state: text('state').$type<PlanState>().notNull(),
    resumeState: text('resume_state').$type<PlanState>(),
    intent: text('intent', { mode: 'json' }).$type<PlanIntent>().notNull(),
    createdByUserId: text('created_by_user_id').notNull(),
    sourceMessageId: text('source_message_id'),
    pageToken: text('page_token').notNull().unique(),
    pageTokenExpiresAt: text('page_token_expires_at'),
    chosenVenueId: text('chosen_venue_id'),
    backupVenueId: text('backup_venue_id'),
    startAt: text('start_at'),
    lockedAt: text('locked_at'),
    messageBudget: integer('message_budget').notNull(),
    messagesUsed: integer('messages_used').notNull().default(0),
    demoMode: integer('demo_mode', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    closedAt: text('closed_at'),
  },
  (t) => [index('plans_chat_state_idx').on(t.chatId, t.state)],
);

export const planMembers = sqliteTable(
  'plan_members',
  {
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    status: text('status').$type<PlanMemberStatus>().notNull(),
    representedByBubble: integer('represented_by_bubble', { mode: 'boolean' })
      .notNull()
      .default(false),
    messagesUsed: integer('messages_used').notNull().default(0),
    joinedAt: text('joined_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.planId, t.userId] })],
);

/** One row per (poll, user, selected option). A new vote replaces the user's rows for the poll. */
export const votes = sqliteTable(
  'votes',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    pollId: text('poll_id').notNull(),
    kind: text('kind').$type<PollKind>().notNull(),
    userId: text('user_id').notNull(),
    choice: text('choice').notNull(),
    at: text('at').notNull(),
  },
  (t) => [
    uniqueIndex('votes_poll_user_choice_idx').on(t.pollId, t.userId, t.choice),
    index('votes_plan_idx').on(t.planId),
  ],
);

export const asks = sqliteTable(
  'asks',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    kind: text('kind').$type<AskKind>().notNull(),
    concession: text('concession', { mode: 'json' }).$type<{
      factType: FactType;
      from: string;
      to: string;
      cost: number;
    } | null>(),
    text: text('text').notNull(),
    status: text('status').$type<AskStatus>().notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    sentAt: text('sent_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (t) => [index('asks_plan_status_idx').on(t.planId, t.status)],
);

export const bookings = sqliteTable(
  'bookings',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    venueId: text('venue_id').notNull(),
    backupVenueId: text('backup_venue_id'),
    status: text('status').$type<BookingStatus>().notNull(),
    partySize: integer('party_size').notNull(),
    startAt: text('start_at').notNull(),
    reservationName: text('reservation_name').notNull(),
    confirmationCode: text('confirmation_code'),
    callId: text('call_id'),
    depositRequested: integer('deposit_requested', { mode: 'boolean' }).notNull().default(false),
    notes: text('notes'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('bookings_plan_idx').on(t.planId)],
);

export const venues = sqliteTable('venues', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  cuisine: text('cuisine').notNull(),
  cuisineTags: text('cuisine_tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
  style: text('style').$type<VenueStyle>().notNull().default('sit_down'),
  dietTags: text('diet_tags', { mode: 'json' }).$type<string[]>().notNull(),
  accessibilityTags: text('accessibility_tags', { mode: 'json' }).$type<string[]>().notNull(),
  priceLevel: integer('price_level').notNull(),
  typicalCostUsd: integer('typical_cost_usd').notNull(),
  hours: text('hours', { mode: 'json' }).$type<OpenInterval[][]>().notNull(),
  phone: text('phone').notNull(),
  lat: real('lat').notNull(),
  lng: real('lng').notNull(),
  address: text('address'),
  neighborhood: text('neighborhood'),
  isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false),
  rating: real('rating'),
  ratingCount: integer('rating_count'),
});

export const ledger = sqliteTable(
  'ledger',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id').notNull(),
    planId: text('plan_id').notNull(),
    userId: text('user_id').notNull(),
    kind: text('kind').$type<LedgerKind>().notNull(),
    amount: real('amount').notNull(),
    note: text('note'),
    at: text('at').notNull(),
  },
  (t) => [index('ledger_group_user_idx').on(t.groupId, t.userId)],
);

/**
 * Durable timers. The timer service scans for fired_at IS NULL AND fire_at <= now every tick.
 * id is normally idempotencyKey(planId, 'timer', kind) so a restart never schedules twice.
 */
export const timers = sqliteTable(
  'timers',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id').notNull(),
    kind: text('kind').notNull(),
    /** Epoch milliseconds. */
    fireAt: integer('fire_at').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    firedAt: text('fired_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('timers_due_idx').on(t.firedAt, t.fireAt), index('timers_plan_idx').on(t.planId)],
);

/** Server-internal audit trail. May contain constraint details; never leaves the server. */
export const audit = sqliteTable(
  'audit',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    planId: text('plan_id'),
    at: text('at').notNull(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    detail: text('detail', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (t) => [index('audit_plan_idx').on(t.planId)],
);

/** Page-visible events. seq is monotonic per plan; payload is the full validated PlanEvent. */
export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    planId: text('plan_id').notNull(),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    at: text('at').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    insertedAt: text('inserted_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (t) => [uniqueIndex('events_plan_seq_idx').on(t.planId, t.seq)],
);

// ---------------------------------------------------------------------------
// Bubbles (P3). Server-internal; nothing here reaches the page or another member.
// ---------------------------------------------------------------------------

/** What a bubble is waiting for from its person. At most one pending question at a time. */
export type BubblePending =
  | { kind: 'allergy_confirm'; factIds: string[] }
  /** A hard fact learned from chat, waiting for a yes before it counts as confirmed. */
  | { kind: 'fact_confirm'; factIds: string[] }
  | { kind: 'crew_confirm'; groupId: string }
  | { kind: 'forget_me_confirm'; expiresAt: string }
  /** "go back" / "change my diet": the next message re-answers this onboarding question. */
  | { kind: 'redo_step'; step: string };

/** Per onboarding question: the message that answered it and the facts it saved. */
export type BubbleAnswers = Record<string, { messageId: string; factIds: string[] }>;

/** Per-person conversation state: onboarding progress and the pending yes/no question. */
export const bubbleState = sqliteTable('bubble_state', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Current onboarding question, null before start and after completion. */
  onboardingStep: text('onboarding_step'),
  onboardingStartedAt: text('onboarding_started_at'),
  onboardingCompletedAt: text('onboarding_completed_at'),
  pending: text('pending', { mode: 'json' }).$type<BubblePending | null>(),
  /** Presence the person set with a command (busy, sleeping, driving), until presenceUntil. */
  presence: text('presence').$type<'focus' | 'sleep' | 'driving'>(),
  presenceUntil: text('presence_until'),
  /** Last location pin the person sent their bubble in iMessage (+ → Location), and when. */
  pinLat: real('pin_lat'),
  pinLng: real('pin_lng'),
  pinAt: text('pin_at'),
  /** Which message answered each onboarding question, so an edit or "go back" can redo it. */
  answers: text('answers', { mode: 'json' }).$type<BubbleAnswers>(),
  updatedAt: text('updated_at').notNull(),
});

/** Inbound DMs a bubble has processed, so a redelivered message is answered once. */
export const bubbleInbox = sqliteTable(
  'bubble_inbox',
  {
    messageId: text('message_id').primaryKey(),
    userId: text('user_id').notNull(),
    handled: integer('handled', { mode: 'boolean' }).notNull(),
    at: text('at').notNull(),
  },
  (t) => [index('bubble_inbox_user_idx').on(t.userId)],
);

/** Crew invitations. An invite waits until its person has finished onboarding. */
export const crewInvites = sqliteTable(
  'crew_invites',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    invitedByUserId: text('invited_by_user_id').notNull(),
    status: text('status').$type<'waiting' | 'sent' | 'accepted' | 'declined'>().notNull(),
    sentAt: text('sent_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

/** Google OAuth tokens for calendar free/busy. Never logged. */
export const googleTokens = sqliteTable('google_tokens', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  refreshToken: text('refresh_token'),
  accessToken: text('access_token'),
  /** Epoch milliseconds. */
  expiryDate: integer('expiry_date'),
  scope: text('scope'),
  updatedAt: text('updated_at').notNull(),
});

export const schema = {
  users,
  facts,
  bubbleState,
  bubbleInbox,
  crewInvites,
  googleTokens,
  groups,
  groupMembers,
  plans,
  planMembers,
  votes,
  asks,
  bookings,
  venues,
  ledger,
  timers,
  audit,
  events,
};
