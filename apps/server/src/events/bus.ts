/**
 * SqliteEventBus: persists every PlanEvent with a per-plan seq, broadcasts to the live page
 * room for the plan's token, and notifies in-process subscribers. Replay serves late viewers.
 */
import { and, asc, desc, eq, isNull, or, gt } from 'drizzle-orm';
import {
  PlanEvent as PlanEventSchema,
  parsePlanEvent,
  type EventBus,
  type EventHandler,
  type PlanEvent,
  type Unsubscribe,
} from '@bubbleworks/shared';
import type { Db } from '../db/client.js';
import { events, plans } from '../db/schema.js';

export type Broadcaster = (token: string, event: PlanEvent) => void;

export interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

export interface SqliteEventBusOptions {
  broadcast?: Broadcaster;
  log?: Logger;
  now?: () => Date;
}

export class SqliteEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private broadcaster: Broadcaster | null;
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    options: SqliteEventBusOptions = {},
  ) {
    this.broadcaster = options.broadcast ?? null;
    this.log = options.log ?? silentLogger;
    this.now = options.now ?? (() => new Date());
  }

  /** The Socket.io bridge attaches after the bus exists, so the broadcaster is settable. */
  setBroadcaster(broadcast: Broadcaster | null): void {
    this.broadcaster = broadcast;
  }

  async publish(input: PlanEvent): Promise<PlanEvent> {
    const event = PlanEventSchema.parse(input);
    const stored = this.db.transaction((tx) => {
      const last = tx
        .select({ seq: events.seq })
        .from(events)
        .where(eq(events.planId, event.planId))
        .orderBy(desc(events.seq))
        .limit(1)
        .get();
      const seq = (last?.seq ?? 0) + 1;
      const withSeq: PlanEvent = { ...event, seq };
      tx.insert(events)
        .values({
          planId: event.planId,
          seq,
          type: event.type,
          at: event.at,
          payload: withSeq as unknown as Record<string, unknown>,
        })
        .run();
      return withSeq;
    });

    const token = this.tokenForPlan(stored.planId);
    if (token && this.broadcaster) {
      try {
        this.broadcaster(token, stored);
      } catch (err) {
        this.log.error({ err, planId: stored.planId }, 'broadcast failed');
      }
    }

    const listeners = [
      ...(this.handlers.get(stored.planId) ?? []),
      ...(this.handlers.get('*') ?? []),
    ];
    for (const handler of listeners) {
      try {
        await handler(stored);
      } catch (err) {
        this.log.error({ err, planId: stored.planId, type: stored.type }, 'event handler failed');
      }
    }
    return stored;
  }

  subscribe(planId: string, handler: EventHandler): Unsubscribe {
    let set = this.handlers.get(planId);
    if (!set) {
      set = new Set();
      this.handlers.set(planId, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
      if (set?.size === 0) this.handlers.delete(planId);
    };
  }

  async replay(planId: string): Promise<PlanEvent[]> {
    const rows = this.db
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.planId, planId))
      .orderBy(asc(events.seq))
      .all();
    return rows.map((r) => parsePlanEvent(r.payload));
  }

  /** Replay for a live page token, or null when the token is unknown or expired. */
  async replayForToken(token: string): Promise<PlanEvent[] | null> {
    const nowIso = this.now().toISOString();
    const row = this.db
      .select({ id: plans.id })
      .from(plans)
      .where(
        and(
          eq(plans.pageToken, token),
          or(isNull(plans.pageTokenExpiresAt), gt(plans.pageTokenExpiresAt, nowIso)),
        ),
      )
      .get();
    if (!row) return null;
    return this.replay(row.id);
  }

  private tokenForPlan(planId: string): string | null {
    const row = this.db
      .select({ token: plans.pageToken })
      .from(plans)
      .where(eq(plans.id, planId))
      .get();
    return row?.token ?? null;
  }
}
