/**
 * Plan state machine: an explicit transition table with guards. Pure; persistence lives in
 * PlanStore. Illegal transitions are rejected with IllegalTransitionError.
 *
 *   IDLE -> DETECTED -> GATHERING -> DELIBERATING <-> DEADLOCK
 *   DELIBERATING | DEADLOCK -> LOCKED -> BOOKING -> BOOKED -> DAY_OF -> CLOSED
 *   Reruns: DELIBERATING <- LOCKED (veto) | BOOKING (declined) | BOOKED (plan change)
 *   Modify: BOOKED | DAY_OF -> BOOKING -> BOOKED
 *   PAUSED is reachable from every live state and returns only to resumeState.
 *   CLOSED, CANCELLED, FAILED are terminal.
 */
import { MIN_PARTY_SIZE, PlanState as PlanStateSchema, type PlanState } from '@bubbleworks/shared';

export const TERMINAL_STATES: ReadonlySet<PlanState> = new Set<PlanState>([
  'CLOSED',
  'CANCELLED',
  'FAILED',
]);

export function isTerminal(state: PlanState): boolean {
  return TERMINAL_STATES.has(state);
}

/** What the guards may look at. Everything optional so callers pass only what they know. */
export interface TransitionContext {
  state: PlanState;
  resumeState: PlanState | null;
  chosenVenueId: string | null;
  startAt: string | null;
  /** Members currently marked in (or represented). */
  inCount?: number;
}

export type Guard = (ctx: TransitionContext) => string | null;

const needsParty: Guard = (ctx) =>
  ctx.inCount !== undefined && ctx.inCount < MIN_PARTY_SIZE
    ? `needs at least ${MIN_PARTY_SIZE} in, have ${ctx.inCount}`
    : null;

const needsVenue: Guard = (ctx) => (ctx.chosenVenueId ? null : 'no chosen venue');

const needsStart: Guard = (ctx) => (ctx.startAt ? null : 'no start time');

const resumesToSaved: Guard = (ctx) =>
  ctx.resumeState === null ? 'paused plan has no resume state' : null;

const LIVE_STATES: readonly PlanState[] = [
  'DETECTED',
  'GATHERING',
  'DELIBERATING',
  'DEADLOCK',
  'LOCKED',
  'BOOKING',
  'BOOKED',
  'DAY_OF',
];

interface Rule {
  to: PlanState;
  guard?: Guard;
}

const TABLE: Record<PlanState, readonly Rule[]> = {
  IDLE: [{ to: 'DETECTED' }, { to: 'CANCELLED' }],
  DETECTED: [{ to: 'GATHERING' }, { to: 'CANCELLED' }, { to: 'FAILED' }, { to: 'PAUSED' }],
  GATHERING: [
    { to: 'DELIBERATING', guard: needsParty },
    { to: 'CLOSED' },
    { to: 'CANCELLED' },
    { to: 'FAILED' },
    { to: 'PAUSED' },
  ],
  DELIBERATING: [
    { to: 'DEADLOCK' },
    { to: 'LOCKED', guard: (ctx) => needsVenue(ctx) ?? needsStart(ctx) },
    { to: 'GATHERING' },
    { to: 'CLOSED' },
    { to: 'CANCELLED' },
    { to: 'FAILED' },
    { to: 'PAUSED' },
  ],
  DEADLOCK: [
    { to: 'DELIBERATING' },
    { to: 'LOCKED', guard: (ctx) => needsVenue(ctx) ?? needsStart(ctx) },
    { to: 'CLOSED' },
    { to: 'CANCELLED' },
    { to: 'FAILED' },
    { to: 'PAUSED' },
  ],
  LOCKED: [
    { to: 'BOOKING', guard: needsVenue },
    { to: 'DELIBERATING' },
    { to: 'CANCELLED' },
    { to: 'FAILED' },
    { to: 'PAUSED' },
  ],
  BOOKING: [
    { to: 'BOOKED' },
    { to: 'DELIBERATING' },
    { to: 'LOCKED' },
    { to: 'CANCELLED' },
    { to: 'FAILED' },
    { to: 'PAUSED' },
  ],
  BOOKED: [
    { to: 'DAY_OF' },
    { to: 'BOOKING' },
    { to: 'DELIBERATING' },
    { to: 'CLOSED' },
    { to: 'CANCELLED' },
    { to: 'FAILED' },
    { to: 'PAUSED' },
  ],
  DAY_OF: [{ to: 'CLOSED' }, { to: 'BOOKING' }, { to: 'CANCELLED' }, { to: 'FAILED' }],
  PAUSED: [
    ...LIVE_STATES.map((to) => ({
      to,
      guard: (ctx: TransitionContext) =>
        resumesToSaved(ctx) ??
        (ctx.resumeState === to ? null : `resume state is ${ctx.resumeState}`),
    })),
    { to: 'CANCELLED' },
    { to: 'FAILED' },
  ],
  CLOSED: [],
  CANCELLED: [],
  FAILED: [],
};

export type TransitionCheck = { ok: true } | { ok: false; reason: string };

export function canTransition(to: PlanState, ctx: TransitionContext): TransitionCheck {
  if (!PlanStateSchema.safeParse(to).success) return { ok: false, reason: `unknown state ${to}` };
  if (ctx.state === to) return { ok: false, reason: `already ${to}` };
  if (isTerminal(ctx.state)) return { ok: false, reason: `${ctx.state} is terminal` };
  const rule = TABLE[ctx.state].find((r) => r.to === to);
  if (!rule) return { ok: false, reason: `no edge ${ctx.state} -> ${to}` };
  const blocked = rule.guard?.(ctx) ?? null;
  return blocked ? { ok: false, reason: blocked } : { ok: true };
}

/** Every legal target from a state, ignoring guards. Handy for docs and tests. */
export function targetsFrom(state: PlanState): PlanState[] {
  return TABLE[state].map((r) => r.to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly planId: string,
    readonly from: PlanState,
    readonly to: PlanState,
    readonly reason: string,
  ) {
    super(`plan ${planId}: illegal transition ${from} -> ${to}: ${reason}`);
    this.name = 'IllegalTransitionError';
  }
}
