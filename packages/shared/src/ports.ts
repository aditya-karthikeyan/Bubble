/**
 * Port interfaces. Owner: P1. Changes need P1 approval.
 *
 * Modules talk only through these interfaces. Each owner ships a fake adapter first
 * (see ./fakes) so every other role builds against the fake in parallel.
 *
 *   PlanEngine, EventBus          P1 (apps/server)
 *   MessagingPort                 P2 (Spectrum adapter)
 *   BubbleService, DoerPorts      P3 (bubbles, Inviter, Splitter, Watcher)
 *   CallerPort                    P4 (ElevenLabs caller agent)
 *
 * Every outbound message and call carries an idempotencyKey. Adapters must treat a repeated
 * key as a no-op and return the original result. Every inbound handler tolerates duplicates.
 */
import type { PlanEvent } from './events.js';
import type {
  BusyInterval,
  Fact,
  GeoPoint,
  IsoDateTime,
  NewFact,
  PlanMember,
  Presence,
  User,
  Venue,
} from './types.js';

export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// MessagingPort (P2)
// ---------------------------------------------------------------------------

export interface SendResult {
  /** Messaging provider's id for the message, used for edits, reactions, and replies. */
  messageId: string;
  /** True when the idempotencyKey had been seen before and nothing was sent. */
  deduplicated: boolean;
}

export interface GroupTextInput {
  chatId: string;
  text: string;
  idempotencyKey: string;
  /** Reply inside the plan's thread when the provider supports it. */
  replyToMessageId?: string;
}

export interface PrivateTextInput {
  userId: string;
  text: string;
  idempotencyKey: string;
}

export interface PollOption {
  /** Stable key reported back in PollVote.choice. */
  key: string;
  label: string;
}

export interface PollInput {
  chatId: string;
  planId: string;
  /** Engine-assigned poll id, reported back in PollVote.pollId. */
  pollId: string;
  question: string;
  options: PollOption[];
  multiSelect?: boolean;
  idempotencyKey: string;
}

export interface RichLinkInput {
  chatId: string;
  url: string;
  title: string;
  description?: string;
  imageUrl?: string;
  idempotencyKey: string;
}

export interface LiveCard {
  title: string;
  /** Short status lines, e.g. ["4 in", "Cuisine: thai leads", "Calling..."]. */
  lines: string[];
  url?: string;
  imageUrl?: string;
}

export interface LiveCardInput {
  chatId: string;
  planId: string;
  card: LiveCard;
  idempotencyKey: string;
}

export interface InboundGroupMessage {
  /** Provider message id. */
  messageId: string;
  chatId: string;
  /** Internal user id. The adapter resolves handles to users before calling the engine. */
  userId: string;
  text: string;
  at: IsoDateTime;
  /** Set when the message is a reply inside a thread. */
  replyToMessageId?: string;
  attachments?: Array<{ kind: 'image' | 'link' | 'other'; url?: string }>;
}

export interface InboundPrivateMessage {
  messageId: string;
  userId: string;
  text: string;
  at: IsoDateTime;
}

export interface PollVote {
  chatId: string;
  pollId: string;
  userId: string;
  /** Option keys the user currently has selected. Empty when the user cleared the vote. */
  choices: string[];
  at: IsoDateTime;
}

export interface Reaction {
  chatId: string;
  messageId: string;
  userId: string;
  /** Emoji character, e.g. "👍". */
  emoji: string;
  removed: boolean;
  at: IsoDateTime;
}

export interface MemberChange {
  chatId: string;
  userId: string;
  change: 'joined' | 'left';
  at: IsoDateTime;
}

export interface MessagingPort {
  sendGroupText(input: GroupTextInput): Promise<SendResult>;
  sendPrivateText(input: PrivateTextInput): Promise<SendResult>;
  sendPoll(input: PollInput): Promise<SendResult>;
  closePoll(input: { chatId: string; pollId: string }): Promise<void>;
  sendRichLink(input: RichLinkInput): Promise<SendResult>;
  editMessage(input: { chatId: string; messageId: string; text: string }): Promise<void>;
  react(input: {
    chatId: string;
    messageId: string;
    emoji: string;
    remove?: boolean;
  }): Promise<void>;
  replyInThread(input: GroupTextInput & { replyToMessageId: string }): Promise<SendResult>;
  setTyping(input: { chatId: string; typing: boolean }): Promise<void>;
  renameGroup(input: { chatId: string; name: string }): Promise<void>;
  setBackground(input: { chatId: string; imageUrl: string }): Promise<void>;
  /** Create or update the single live status card for a plan. */
  upsertLiveCard(input: LiveCardInput): Promise<SendResult>;

  onGroupMessage(handler: (message: InboundGroupMessage) => Promise<void>): Unsubscribe;
  onPrivateMessage(handler: (message: InboundPrivateMessage) => Promise<void>): Unsubscribe;
  onPollVote(handler: (vote: PollVote) => Promise<void>): Unsubscribe;
  onReaction(handler: (reaction: Reaction) => Promise<void>): Unsubscribe;
  onMemberChange(handler: (change: MemberChange) => Promise<void>): Unsubscribe;
}

// ---------------------------------------------------------------------------
// BubbleService (P3)
// ---------------------------------------------------------------------------

export interface BubbleProfile {
  user: User;
  facts: Fact[];
  /** Venue ids visited through Bubbleworks recently, newest first. */
  recentVenueIds: string[];
  /** Count of concessions this member accepted recently, for fairness weighting. */
  recentCompromiseCount: number;
}

export interface BubbleService {
  /** Full profile. Server-internal only; never forwarded to the page or another member. */
  getProfile(userId: string): Promise<BubbleProfile>;
  /** Facts with hard = true. */
  getHardLimits(userId: string): Promise<Fact[]>;
  /** Facts with hard = false. */
  getSoftPrefs(userId: string): Promise<Fact[]>;
  getPresence(userId: string): Promise<Presence>;
  /** Live location when shared through Find My, otherwise null. */
  getLocation(userId: string): Promise<GeoPoint | null>;
  getFreeBusy(
    userId: string,
    range: { start: IsoDateTime; end: IsoDateTime },
  ): Promise<BusyInterval[]>;
  recordFact(fact: NewFact): Promise<Fact>;
  /** Start onboarding for a member who just joined the group. */
  onNewMember(input: { groupId: string; chatId: string; userId: string }): Promise<void>;
  /**
   * A private message that is not an answer to a pending ask. The bubble may learn a fact or
   * answer a question. Returns handled = false when the engine should treat it as a command.
   */
  onPrivateMessage(message: InboundPrivateMessage): Promise<{ handled: boolean }>;
}

// ---------------------------------------------------------------------------
// DoerPorts (P3)
// ---------------------------------------------------------------------------

export interface BookingSummary {
  bookingId: string;
  planId: string;
  chatId: string;
  venue: Venue;
  startAt: IsoDateTime;
  partySize: number;
  reservationName: string;
  confirmationCode: string | null;
  members: PlanMember[];
}

export interface DoerResult {
  ok: boolean;
  detail?: string;
}

export interface DoerPorts {
  inviter: {
    /** Send calendar invites to members marked in. */
    send(input: BookingSummary & { idempotencyKey: string }): Promise<DoerResult>;
  };
  splitter: {
    /** Post the split plan and Venmo requests, weighted by the fairness ledger. */
    send(input: BookingSummary & { idempotencyKey: string }): Promise<DoerResult>;
  };
  watcher: {
    /** Watch for day-of changes: lateness, location, venue closure. */
    start(input: BookingSummary): Promise<void>;
    stop(input: { planId: string }): Promise<void>;
  };
}

// ---------------------------------------------------------------------------
// CallerPort (P4)
// ---------------------------------------------------------------------------

export interface BookRequest {
  planId: string;
  bookingId: string;
  venue: Venue;
  /** Tried when the primary venue declines or does not answer. */
  backupVenue: Venue | null;
  partySize: number;
  startAt: IsoDateTime;
  reservationName: string;
  /** Allergies to mention at the table level, aggregated, never attributed. Empty when < 3 people share. */
  tableNotes: string[];
  idempotencyKey: string;
}

export interface CallHandle {
  callId: string;
  status: 'queued' | 'dialing' | 'in_call';
}

export type CallOutcome =
  | 'booked'
  | 'booked_backup'
  | 'declined'
  | 'no_answer'
  | 'needs_human'
  | 'modified'
  | 'cancelled'
  | 'failed';

/** Delivered to PlanEngine.handleCallResult by the caller adapter (webhook or fake). */
export interface CallResult {
  planId: string;
  bookingId: string;
  callId: string;
  outcome: CallOutcome;
  /** Venue that actually took the booking. */
  venueId: string | null;
  confirmationCode: string | null;
  /** Start time the venue confirmed, when it differs from the request. */
  confirmedStartAt: IsoDateTime | null;
  depositRequested: boolean;
  /** One safe line for the group, e.g. "Table for 4 at 7:30 under Aditya." */
  summary: string;
  at: IsoDateTime;
}

export interface CallerPort {
  book(request: BookRequest): Promise<CallHandle>;
  modify(input: {
    planId: string;
    bookingId: string;
    venue: Venue;
    partySize: number;
    startAt: IsoDateTime;
    reservationName: string;
    idempotencyKey: string;
  }): Promise<CallHandle>;
  cancel(input: {
    planId: string;
    bookingId: string;
    venue: Venue;
    reservationName: string;
    idempotencyKey: string;
  }): Promise<CallHandle>;
  holdTable(input: {
    planId: string;
    bookingId: string;
    venue: Venue;
    partySize: number;
    startAt: IsoDateTime;
    holdMinutes: number;
    idempotencyKey: string;
  }): Promise<CallHandle>;
}

// ---------------------------------------------------------------------------
// PlanEngine (P1)
// ---------------------------------------------------------------------------

export interface IntentInput {
  chatId: string;
  userId: string;
  messageId: string;
  text: string;
  at: IsoDateTime;
}

export interface IntentResult {
  /** Null when the message was not a plan intent. */
  planId: string | null;
  created: boolean;
}

export interface VoteInput {
  planId: string;
  pollId: string;
  userId: string;
  choices: string[];
  at: IsoDateTime;
}

export interface HeadcountInput {
  planId: string;
  userId: string;
  in: boolean;
  at: IsoDateTime;
}

export interface AskAnswerInput {
  askId: string;
  userId: string;
  answer: 'yes' | 'no';
  rawText: string;
  at: IsoDateTime;
}

export interface MemberChangeInput {
  chatId: string;
  userId: string;
  change: 'joined' | 'left';
  at: IsoDateTime;
}

export type PlanCommand = 'wait' | 'resume' | 'cancel' | 'veto' | 'why';

export interface CommandInput {
  chatId: string;
  userId: string;
  command: PlanCommand;
  /** Set when the command arrived inside a plan's thread. */
  planId?: string;
  messageId: string;
  at: IsoDateTime;
}

export interface PlanEngine {
  handleIntent(input: IntentInput): Promise<IntentResult>;
  handleVote(input: VoteInput): Promise<void>;
  handleHeadcount(input: HeadcountInput): Promise<void>;
  handleAskAnswer(input: AskAnswerInput): Promise<void>;
  handleMemberChange(input: MemberChangeInput): Promise<void>;
  handleCallResult(result: CallResult): Promise<void>;
  handleCommand(input: CommandInput): Promise<void>;
}

// ---------------------------------------------------------------------------
// EventBus (P1)
// ---------------------------------------------------------------------------

export type EventHandler = (event: PlanEvent) => void | Promise<void>;

export interface EventBus {
  /** Persist, assign seq, broadcast to the plan's page room, and notify subscribers. */
  publish(event: PlanEvent): Promise<PlanEvent>;
  /** planId or "*" for every plan. */
  subscribe(planId: string, handler: EventHandler): Unsubscribe;
  /** Past events for a plan in seq order, for late page viewers. */
  replay(planId: string): Promise<PlanEvent[]>;
}
