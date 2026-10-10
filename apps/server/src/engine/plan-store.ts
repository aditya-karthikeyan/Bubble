/**
 * PlanStore: plans and plan members in SQLite, with every state change going through the
 * transition table, persisted in one transaction with an audit row, then published as
 * plan_state_changed. Terminal transitions stamp closedAt and the page token expiry.
 */
import { and, eq, notInArray } from 'drizzle-orm';
import {
  DEADLINES,
  PLAN_MESSAGE_BUDGET,
  Plan as PlanSchema,
  PlanMember as PlanMemberSchema,
  newId,
  newPageToken,
  type EventBus,
  type Plan,
  type PlanIntent,
  type PlanMember,
  type PlanMemberStatus,
  type PlanState,
} from '@bubbleworks/shared';
import type { Db } from '../db/client.js';
import { audit, planMembers, plans } from '../db/schema.js';
import { silentLogger, type Logger } from '../events/bus.js';
import {
  canTransition,
  IllegalTransitionError,
  isTerminal,
  TERMINAL_STATES,
  type TransitionContext,
} from './state-machine.js';

export interface CreatePlanInput {
  groupId: string;
  chatId: string;
  intent: PlanIntent;
  createdByUserId: string;
  sourceMessageId?: string | null;
  demoMode?: boolean;
  id?: string;
}

export interface TransitionOptions {
  reason?: string;
  /** Extra guard inputs. inCount defaults to the count of members in or represented. */
  ctx?: Partial<Pick<TransitionContext, 'inCount'>>;
  actor?: string;
}

export interface PlanStoreOptions {
  log?: Logger;
  now?: () => Date;
  pageTokenTtlMs?: number;
}

export class PlanStore {
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly pageTokenTtlMs: number;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    options: PlanStoreOptions = {},
  ) {
    this.log = options.log ?? silentLogger;
    this.now = options.now ?? (() => new Date());
    this.pageTokenTtlMs = options.pageTokenTtlMs ?? DEADLINES.page_token_ttl_after_close_ms;
  }

  /** Create a plan in IDLE. Callers transition to DETECTED right away. */
  create(input: CreatePlanInput): Plan {
    const at = this.now().toISOString();
    const row: typeof plans.$inferInsert = {
      id: input.id ?? newId('plan'),
      groupId: input.groupId,
      chatId: input.chatId,
      state: 'IDLE',
      resumeState: null,
      intent: input.intent,
      createdByUserId: input.createdByUserId,
      sourceMessageId: input.sourceMessageId ?? null,
      pageToken: newPageToken(),
      pageTokenExpiresAt: null,
      chosenVenueId: null,
      backupVenueId: null,
      startAt: null,
      lockedAt: null,
      messageBudget: PLAN_MESSAGE_BUDGET,
      messagesUsed: 0,
      demoMode: input.demoMode ?? false,
      createdAt: at,
      updatedAt: at,
      closedAt: null,
    };
    this.db.insert(plans).values(row).run();
    this.audit(row.id, 'plan_created', { intent: input.intent, by: input.createdByUserId });
    return this.mustGet(row.id);
  }

  get(planId: string): Plan | null {
    const row = this.db.select().from(plans).where(eq(plans.id, planId)).get();
    return row ? toPlan(row) : null;
  }

  mustGet(planId: string): Plan {
    const plan = this.get(planId);
    if (!plan) throw new Error(`plan ${planId} not found`);
    return plan;
  }

  findByPageToken(token: string): Plan | null {
    const row = this.db.select().from(plans).where(eq(plans.pageToken, token)).get();
    return row ? toPlan(row) : null;
  }

  /** Plans in a chat that are not terminal, newest first. */
  findActiveForChat(chatId: string): Plan[] {
    return this.db
      .select()
      .from(plans)
      .where(and(eq(plans.chatId, chatId), notInArray(plans.state, [...TERMINAL_STATES])))
      .all()
      .map(toPlan)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Every non-terminal plan, for resume after a restart. */
  findAllActive(): Plan[] {
    return this.db
      .select()
      .from(plans)
      .where(notInArray(plans.state, [...TERMINAL_STATES]))
      .all()
      .map(toPlan);
  }

  /**
   * Move the plan to `to`. Rejects with IllegalTransitionError (after logging and an audit
   * row) when the table or a guard says no. On success the row, an audit entry, and the
   * plan_state_changed event are all written.
   */
  async transition(planId: string, to: PlanState, options: TransitionOptions = {}): Promise<Plan> {
    const at = this.now().toISOString();
    type Outcome = { error: IllegalTransitionError } | { from: PlanState };
    const result: Outcome = this.db.transaction((tx): Outcome => {
      const row = tx.select().from(plans).where(eq(plans.id, planId)).get();
      if (!row) throw new Error(`plan ${planId} not found`);
      const inCount =
        options.ctx?.inCount ??
        tx
          .select()
          .from(planMembers)
          .where(eq(planMembers.planId, planId))
          .all()
          .filter((m) => m.status === 'in' || m.status === 'represented').length;
      const ctx: TransitionContext = {
        state: row.state,
        resumeState: row.resumeState,
        chosenVenueId: row.chosenVenueId,
        startAt: row.startAt,
        inCount,
      };
      const check = canTransition(to, ctx);
      if (!check.ok) {
        tx.insert(audit)
          .values({
            planId,
            at,
            actor: options.actor ?? 'engine',
            action: 'illegal_transition',
            detail: { from: row.state, to, reason: check.reason, requested: options.reason },
          })
          .run();
        return { error: new IllegalTransitionError(planId, row.state, to, check.reason) };
      }

      const patch: Partial<typeof plans.$inferInsert> = { state: to, updatedAt: at };
      if (to === 'PAUSED') patch.resumeState = row.state;
      else if (row.state === 'PAUSED') patch.resumeState = null;
      if (to === 'LOCKED') patch.lockedAt = at;
      if (isTerminal(to)) {
        patch.closedAt = at;
        patch.pageTokenExpiresAt = new Date(
          this.now().getTime() + this.pageTokenTtlMs,
        ).toISOString();
      }
      tx.update(plans).set(patch).where(eq(plans.id, planId)).run();
      tx.insert(audit)
        .values({
          planId,
          at,
          actor: options.actor ?? 'engine',
          action: 'transition',
          detail: { from: row.state, to, reason: options.reason },
        })
        .run();
      return { from: row.state };
    });

    if ('error' in result) {
      this.log.warn(
        { planId, from: result.error.from, to, reason: result.error.reason },
        'illegal transition rejected',
      );
      throw result.error;
    }

    this.log.info({ planId, from: result.from, to, reason: options.reason }, 'plan transition');
    await this.bus.publish({
      type: 'plan_state_changed',
      planId,
      at,
      from: result.from,
      to,
      ...(options.reason ? { reason: options.reason } : {}),
    });
    return this.mustGet(planId);
  }

  /** Convenience: try a transition and report instead of throwing. */
  async tryTransition(
    planId: string,
    to: PlanState,
    options: TransitionOptions = {},
  ): Promise<{ ok: true; plan: Plan } | { ok: false; error: IllegalTransitionError }> {
    try {
      return { ok: true, plan: await this.transition(planId, to, options) };
    } catch (err) {
      if (err instanceof IllegalTransitionError) return { ok: false, error: err };
      throw err;
    }
  }

  setChoice(
    planId: string,
    choice: { chosenVenueId: string | null; backupVenueId: string | null; startAt: string | null },
  ): Plan {
    this.db
      .update(plans)
      .set({ ...choice, updatedAt: this.now().toISOString() })
      .where(eq(plans.id, planId))
      .run();
    return this.mustGet(planId);
  }

  /** Count one group message against the plan's budget. Returns remaining, or -1 if exceeded. */
  spendMessage(planId: string): number {
    const plan = this.mustGet(planId);
    if (plan.messagesUsed >= plan.messageBudget) return -1;
    this.db
      .update(plans)
      .set({ messagesUsed: plan.messagesUsed + 1, updatedAt: this.now().toISOString() })
      .where(eq(plans.id, planId))
      .run();
    return plan.messageBudget - plan.messagesUsed - 1;
  }

  // -- members -----------------------------------------------------------------

  upsertMember(
    planId: string,
    userId: string,
    status: PlanMemberStatus,
    representedByBubble = false,
  ): PlanMember {
    const at = this.now().toISOString();
    this.db
      .insert(planMembers)
      .values({ planId, userId, status, representedByBubble, joinedAt: at, updatedAt: at })
      .onConflictDoUpdate({
        target: [planMembers.planId, planMembers.userId],
        set: { status, representedByBubble, updatedAt: at },
      })
      .run();
    const row = this.db
      .select()
      .from(planMembers)
      .where(and(eq(planMembers.planId, planId), eq(planMembers.userId, userId)))
      .get();
    return PlanMemberSchema.parse(row);
  }

  members(planId: string): PlanMember[] {
    return this.db
      .select()
      .from(planMembers)
      .where(eq(planMembers.planId, planId))
      .all()
      .map((r) => PlanMemberSchema.parse(r));
  }

  inCount(planId: string): number {
    return this.members(planId).filter((m) => m.status === 'in' || m.status === 'represented')
      .length;
  }

  audit(planId: string | null, action: string, detail?: Record<string, unknown>): void {
    this.db
      .insert(audit)
      .values({ planId, at: this.now().toISOString(), actor: 'engine', action, detail })
      .run();
  }
}

export function toPlan(row: typeof plans.$inferSelect): Plan {
  return PlanSchema.parse(row);
}
