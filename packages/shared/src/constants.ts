/**
 * Product constants. Owner: P1.
 * Deadlines are milliseconds. DEMO_MODE scales every deadline to DEMO_MODE_DEADLINE_MS.
 */

export const DEMO_MODE_DEADLINE_MS = 60_000;

export interface Deadlines {
  /** How long the headcount and cuisine poll stay open before the solver runs with what it has. */
  poll_ms: number;
  /** Private concession ask timeout. */
  private_ask_ms: number;
  /** Veto window after lock before the caller dials. */
  veto_window_ms: number;
  /** How long a call may run before it is declared failed. */
  call_ms: number;
  /** Live page tokens expire this long after the plan closes. */
  page_token_ttl_after_close_ms: number;
}

export const DEADLINES: Deadlines = {
  poll_ms: 10 * 60_000,
  private_ask_ms: 2 * 60_000,
  veto_window_ms: 60_000,
  call_ms: 90_000,
  page_token_ttl_after_close_ms: 2 * 60 * 60_000,
};

/** DEMO_MODE values. Asks and the veto window stay shorter than 60 s so a rehearsal fits. */
export const DEMO_DEADLINES: Deadlines = {
  poll_ms: DEMO_MODE_DEADLINE_MS,
  private_ask_ms: 30_000,
  veto_window_ms: 15_000,
  call_ms: DEMO_MODE_DEADLINE_MS,
  page_token_ttl_after_close_ms: DEADLINES.page_token_ttl_after_close_ms,
};

export const SPEED_TARGETS_MS = {
  typing_after_detect: 1_000,
  poll_after_detect: 5_000,
  dial_after_lock: 2_000,
  booked_after_lock: 90_000,
} as const;

/** Maximum messages the agent sends to one member for one plan. Private asks do not count. */
export const PLAN_MESSAGE_BUDGET = 8;

/** Aggregates about members appear only when at least this many people are included. */
export const MIN_AGGREGATE_GROUP_SIZE = 3;

/** Fewer than this many people marked in closes the plan. */
export const MIN_PARTY_SIZE = 2;

/** Timer service poll interval. */
export const TIMER_TICK_MS = 250;

/** Deadlock concession steps. */
export const CONCESSION_STEPS = {
  budget_step_usd: 5,
  budget_max_usd: 15,
  distance_step_min: 10,
  distance_max_min: 20,
  time_step_min: 30,
  time_max_min: 60,
} as const;

/** Venue search radius from the hackathon address. */
export const VENUE_RADIUS_M = 1_500;

/** Timing marks recorded in structured logs, in order of occurrence. */
export const TIMING_MARKS = [
  't_detect',
  't_typing',
  't_poll_posted',
  't_lock',
  't_dial',
  't_booked',
] as const;
export type TimingMark = (typeof TIMING_MARKS)[number];

export const MODELS = {
  fast: 'claude-haiku-4-5-20251001',
  hard_parsing: 'claude-sonnet-5-5',
} as const;

/** Socket.io contract between apps/server and apps/web. */
export const SOCKET = {
  namespace: '/live',
  /** Client -> server. Payload: { token: string }. Ack: JoinAck. */
  join: 'join',
  /** Client -> server. Ack: { pong: true, at: string }. */
  ping: 'ping',
  /** Server -> room. Payload: PlanEvent. */
  plan_event: 'plan_event',
  room: (token: string) => `plan:${token}`,
} as const;
