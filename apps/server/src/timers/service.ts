/**
 * Durable timers. Rows live in the timers table, so a restart picks up every pending timer.
 * A tick every TIMER_TICK_MS claims due rows (fired_at set atomically) and runs handlers.
 * DEMO_MODE swaps DEADLINES for DEMO_DEADLINES; tests can override any deadline.
 */
import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import {
  DEADLINES,
  DEMO_DEADLINES,
  TIMER_TICK_MS,
  idempotencyKey,
  type Deadlines,
  type Unsubscribe,
} from '@bubbleworks/shared';
import type { Db } from '../db/client.js';
import { timers } from '../db/schema.js';
import { silentLogger, type Logger } from '../events/bus.js';

/** Timer kinds the engine schedules. Deadline-backed kinds map to a Deadlines key. */
export const TIMER_KINDS = [
  'poll_deadline',
  'ask_timeout',
  'veto_window',
  'call_timeout',
  'day_of',
  'page_token_expiry',
  'custom',
] as const;
export type TimerKind = (typeof TIMER_KINDS)[number];

export const DEADLINE_FOR_KIND: Partial<Record<TimerKind, keyof Deadlines>> = {
  poll_deadline: 'poll_ms',
  ask_timeout: 'private_ask_ms',
  veto_window: 'veto_window_ms',
  call_timeout: 'call_ms',
  page_token_expiry: 'page_token_ttl_after_close_ms',
};

export interface TimerRecord {
  id: string;
  planId: string;
  kind: TimerKind;
  fireAt: number;
  payload: Record<string, unknown>;
  firedAt: string | null;
  createdAt: string;
}

export interface FiredTimer extends TimerRecord {
  firedAt: string;
  /** How late the timer fired, in ms. Large values mean the process was down. */
  lateMs: number;
}

export type TimerHandler = (timer: FiredTimer) => void | Promise<void>;

export interface ScheduleInput {
  planId: string;
  kind: TimerKind;
  payload?: Record<string, unknown>;
  /** One of delayMs or fireAt. Omit both for a deadline-backed kind to use the configured deadline. */
  delayMs?: number;
  fireAt?: number | Date | string;
  /** Default idempotencyKey(planId, 'timer', kind): one live timer per plan and kind. */
  id?: string;
  /** Replace an existing unfired timer with the same id instead of keeping the first. */
  replace?: boolean;
}

export interface TimerServiceOptions {
  demoMode?: boolean;
  /** Override individual deadlines (simulations use very short ones). */
  deadlines?: Partial<Deadlines>;
  tickMs?: number;
  log?: Logger;
  now?: () => number;
}

export class TimerService {
  readonly deadlines: Deadlines;
  private readonly tickMs: number;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly handlers = new Map<string, Set<TimerHandler>>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly db: Db,
    options: TimerServiceOptions = {},
  ) {
    this.deadlines = {
      ...(options.demoMode ? DEMO_DEADLINES : DEADLINES),
      ...options.deadlines,
    };
    this.tickMs = options.tickMs ?? TIMER_TICK_MS;
    this.log = options.log ?? silentLogger;
    this.now = options.now ?? (() => Date.now());
  }

  schedule(input: ScheduleInput): TimerRecord {
    const id = input.id ?? idempotencyKey(input.planId, 'timer', input.kind);
    const fireAt = this.resolveFireAt(input);
    const createdAt = new Date(this.now()).toISOString();
    const row = {
      id,
      planId: input.planId,
      kind: input.kind,
      fireAt,
      payload: input.payload ?? {},
      firedAt: null,
      createdAt,
    };
    if (input.replace) {
      this.db
        .insert(timers)
        .values(row)
        .onConflictDoUpdate({
          target: timers.id,
          set: { fireAt, payload: row.payload, firedAt: null, createdAt },
        })
        .run();
    } else {
      this.db.insert(timers).values(row).onConflictDoNothing().run();
    }
    const stored = this.get(id);
    if (!stored) throw new Error(`timer ${id} vanished after insert`);
    this.log.debug(
      { planId: input.planId, kind: input.kind, fireAt: new Date(stored.fireAt).toISOString() },
      'timer scheduled',
    );
    return stored;
  }

  /** Remove unfired timers for a plan, optionally only one kind. Returns how many. */
  cancel(planId: string, kind?: TimerKind): number {
    const where = kind
      ? and(eq(timers.planId, planId), eq(timers.kind, kind), isNull(timers.firedAt))
      : and(eq(timers.planId, planId), isNull(timers.firedAt));
    return this.db.delete(timers).where(where).run().changes;
  }

  get(id: string): TimerRecord | null {
    const row = this.db.select().from(timers).where(eq(timers.id, id)).get();
    return row ? toRecord(row) : null;
  }

  pending(planId?: string): TimerRecord[] {
    const where = planId
      ? and(eq(timers.planId, planId), isNull(timers.firedAt))
      : isNull(timers.firedAt);
    return this.db
      .select()
      .from(timers)
      .where(where)
      .orderBy(asc(timers.fireAt))
      .all()
      .map(toRecord);
  }

  /** Register a handler for one kind or '*'. */
  on(kind: TimerKind | '*', handler: TimerHandler): Unsubscribe {
    let set = this.handlers.get(kind);
    if (!set) {
      set = new Set();
      this.handlers.set(kind, set);
    }
    set.add(handler);
    return () => void set?.delete(handler);
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => void this.tick(), this.tickMs);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /** Fire every due timer once. Safe to call directly from tests and simulations. */
  async tick(): Promise<FiredTimer[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const fired: FiredTimer[] = [];
    try {
      const now = this.now();
      const due = this.db
        .select()
        .from(timers)
        .where(and(isNull(timers.firedAt), lte(timers.fireAt, now)))
        .orderBy(asc(timers.fireAt))
        .all();
      for (const row of due) {
        const firedAt = new Date(now).toISOString();
        const claimed = this.db
          .update(timers)
          .set({ firedAt })
          .where(and(eq(timers.id, row.id), isNull(timers.firedAt)))
          .run().changes;
        if (claimed !== 1) continue;
        const timer: FiredTimer = { ...toRecord(row), firedAt, lateMs: now - row.fireAt };
        fired.push(timer);
        this.log.info(
          { planId: timer.planId, kind: timer.kind, lateMs: timer.lateMs },
          'timer fired',
        );
        const listeners = [
          ...(this.handlers.get(timer.kind) ?? []),
          ...(this.handlers.get('*') ?? []),
        ];
        for (const handler of listeners) {
          try {
            await handler(timer);
          } catch (err) {
            this.log.error({ err, planId: timer.planId, kind: timer.kind }, 'timer handler failed');
          }
        }
      }
    } finally {
      this.ticking = false;
    }
    return fired;
  }

  private resolveFireAt(input: ScheduleInput): number {
    if (input.fireAt !== undefined) {
      if (typeof input.fireAt === 'number') return input.fireAt;
      return new Date(input.fireAt).getTime();
    }
    if (input.delayMs !== undefined) return this.now() + input.delayMs;
    const key = DEADLINE_FOR_KIND[input.kind];
    if (!key) throw new Error(`timer kind ${input.kind} needs delayMs or fireAt`);
    return this.now() + this.deadlines[key];
  }
}

function toRecord(row: typeof timers.$inferSelect): TimerRecord {
  return {
    id: row.id,
    planId: row.planId,
    kind: row.kind as TimerKind,
    fireAt: row.fireAt,
    payload: row.payload,
    firedAt: row.firedAt,
    createdAt: row.createdAt,
  };
}
