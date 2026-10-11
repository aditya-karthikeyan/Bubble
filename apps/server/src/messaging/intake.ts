/**
 * PlanIntake: inbound messaging -> PlanEngine, and the engine's question decision -> the bundle.
 *
 *   text arrives     -> plan words? typing bubble in the sender's DM right away (pre-batch)
 *   group message    -> open plan in that crew? parse RSVP (rules, then Haiku) -> handleHeadcount
 *                       else detect (rules; Haiku for weak) -> handleIntent
 *   👍 on headcount  -> handleHeadcount(in)       👎 -> handleHeadcount(out)
 *   poll vote        -> handleVote(choices)
 *   renderBundle()   -> poll + headcount + link to every member, typing off
 *
 * Timing marks (structured logs): t_detect, t_typing, t_poll_posted, in ms since the message
 * reached the server (and lagMs: phone send time to receipt).
 */
import {
  idempotencyKey,
  type CrewDirectory,
  type PlanEngine,
  type PollOption,
} from '@bubbleworks/shared';
import type { Logger } from '../events/bus.js';
import { dmChatId, type SpectrumMessaging } from './adapter.js';
import {
  maybeSendPoll,
  renderBundle,
  type BundleMode,
  type BundleResult,
  type BundleStore,
  type QuestionDecision,
} from './bundle.js';
import type { Classifier } from './classifier.js';
import {
  detectPlan,
  isQuestion,
  parsePlanCommand,
  parseRsvp,
  stanceFromEmoji,
  type RsvpStance,
} from './detect.js';
import type { AuditLog } from './safety.js';

export interface PlanIntakeOptions {
  port: SpectrumMessaging;
  engine: PlanEngine;
  bundles: BundleStore;
  classifier: Classifier | null;
  log: Logger;
  /** Crew lookup for the "which crew?" question when someone is in more than one. */
  crews?: Pick<CrewDirectory, 'crewsOf'>;
  timezone?: string;
  now?: () => Date;
  /** Haiku must be at least this sure before a weak detection starts a plan. */
  minConfidence?: number;
  /** Records pauses, resumes, cancels, and vetoes. */
  audit?: AuditLog;
  /** staged (default): headcount first, poll once enough are in, link at deliberation. */
  bundleMode?: BundleMode;
  /** False while someone is still onboarding: "Chipotle and Cava" answers a question, so no typing. */
  isOnboarded?: (userId: string) => boolean;
}

interface Marks {
  receivedAt: number;
  lagMs: number;
  userId: string;
  typingAt?: number;
  detectAt?: number;
}

export class PlanIntake {
  /** Plan messages waiting on "which crew?", by user. */
  private readonly pendingPicks = new Map<
    string,
    {
      text: string;
      chatId: string | null;
      crews: Array<{ name: string; chatId: string }>;
      expiresAt: number;
    }
  >();
  private readonly marks = new Map<string, Marks>(); // by userId, newest message
  private readonly planMarks = new Map<string, Marks>(); // by planId
  /** Marks of the intent being handled, for an engine that renders the bundle inside handleIntent. */
  private inflight: Marks | null = null;
  private readonly timezone: string;
  private readonly now: () => Date;

  constructor(private readonly o: PlanIntakeOptions) {
    this.timezone = o.timezone ?? 'America/New_York';
    this.now = o.now ?? (() => new Date());
  }

  start(): void {
    this.o.classifier?.warm?.();
    this.o.port.onTextReceived((userId, text, at) => this.onRawText(userId, text, at));
    this.o.port.onGroupMessage(async (m) => this.onGroupMessage(m));
    this.o.port.onReaction(async (r) => this.onReaction(r));
    this.o.port.onPollVote(async (v) => this.onPollVote(v));
  }

  /** Called by the engine's question policy once it knows what to ask. */
  async renderBundle(decision: QuestionDecision): Promise<BundleResult> {
    const marks = this.planMarks.get(decision.planId) ?? this.inflight;
    const bundleStart = Date.now();
    const result = await renderBundle(this.o.port, this.o.bundles, decision, {
      mode: this.o.bundleMode ?? 'staged',
      organizerUserId: marks?.userId ?? null,
    });
    // Opt-out headcount: everyone already counts as in, so the poll can go out right away.
    if (decision.headcount.mode === 'opt_out') {
      await maybeSendPoll(this.o.port, this.o.bundles, decision.planId, { force: true });
    }
    if (marks) {
      this.planMarks.set(decision.planId, marks);
      void this.o.port.setTyping({ chatId: dmChatId(marks.userId), typing: false });
      const sinceReceipt = (ms: number) => bundleStart - marks.receivedAt + ms;
      this.o.log.info(
        {
          planId: decision.planId,
          mark: result.pollMs !== null ? 't_poll_posted' : 't_headcount_posted',
          ms: sinceReceipt(result.pollMs ?? result.ms),
          bundleDoneMs: sinceReceipt(result.ms),
          lagMs: marks.lagMs,
        },
        'timing',
      );
    }
    return result;
  }

  /** A yes or no landed: count it, and send the poll once enough people are in. */
  private async recordHeadcount(planId: string, userId: string, isIn: boolean): Promise<void> {
    const count = this.o.bundles.markIn(planId, userId, isIn);
    if (!isIn) return;
    const pollMessageId = await maybeSendPoll(this.o.port, this.o.bundles, planId);
    if (pollMessageId) {
      this.o.log.info({ planId, mark: 't_poll_posted', inCount: count }, 'timing');
    }
  }

  /** Engine rewrites a question before it goes out (cuisine options once the style is known). */
  updatePoll(planId: string, pollId: string, options: PollOption[] | null): boolean {
    return this.o.bundles.updatePoll(planId, pollId, options);
  }

  /** Engine signals the plan stopped collecting answers (decided, closed, cancelled). */
  closePlan(planId: string): void {
    this.o.bundles.close(planId);
    this.planMarks.delete(planId);
  }

  // -- inbound ---------------------------------------------------------------

  /** Returns true to skip the batch window: a clear plan should not wait 1.5 s. */
  private onRawText(userId: string, text: string, at: string): boolean {
    const receivedAt = Date.now();
    const marks: Marks = { receivedAt, lagMs: Math.max(0, receivedAt - Date.parse(at)), userId };
    this.marks.set(userId, marks);
    const detection = detectPlan(text);
    if (detection.level === 'none') return false;
    // "I'm in" is an RSVP, not a plan; "down for dinner tonight?" names a meal, so it is a plan.
    if (detection.meal === null && parseRsvp(text) !== 'unclear') return false;
    if (this.o.isOnboarded && !this.o.isOnboarded(userId)) return false;
    marks.typingAt = Date.now();
    void this.o.port.setTyping({ chatId: dmChatId(userId), typing: true });
    this.o.log.info({ userId, mark: 't_typing', ms: marks.typingAt - receivedAt }, 'timing');
    return detection.level === 'strong';
  }

  private async onGroupMessage(m: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    at: string;
  }): Promise<void> {
    const open = this.o.bundles.openForChat(m.chatId);

    // "wait", "resume", "veto", "cancel", "why this place?" always reach the engine.
    const command = parsePlanCommand(m.text);
    if (command) {
      if (this.marks.get(m.userId)?.typingAt) {
        void this.o.port.setTyping({ chatId: dmChatId(m.userId), typing: false });
      }
      await this.o.engine.handleCommand({
        chatId: m.chatId,
        userId: m.userId,
        command,
        ...(open ? { planId: open.planId } : {}),
        messageId: m.messageId,
        at: m.at,
      });
      if (command !== 'why') {
        const kind = command === 'wait' ? 'pause' : command;
        this.o.audit?.record({
          userId: m.userId,
          planId: open?.planId ?? null,
          kind,
          detail: { via: 'dm' },
        });
      }
      this.o.log.info({ userId: m.userId, command, planId: open?.planId ?? null }, 'plan command');
      return;
    }

    if (open) {
      const stance = await this.rsvpStance(m.text, open.organizerName, open.meal);
      if (stance !== 'unclear') {
        await this.o.engine.handleHeadcount({
          planId: open.planId,
          userId: m.userId,
          in: stance === 'in',
          at: m.at,
        });
        await this.recordHeadcount(open.planId, m.userId, stance === 'in');
        this.o.log.info(
          { planId: open.planId, userId: m.userId, stance, via: 'reply' },
          'headcount',
        );
        return;
      }
    }

    // A reply to "which crew?" carries the plan message that was waiting on it.
    const picked = this.pendingPicks.get(m.userId);
    const resolvedPick = picked !== undefined && picked.chatId === m.chatId;
    const text = resolvedPick ? picked.text : m.text;
    if (resolvedPick) this.pendingPicks.delete(m.userId);

    const marks = this.marks.get(m.userId);
    const isPlan = resolvedPick ? true : await this.isPlanIntent(text);
    if (!isPlan) {
      if (marks?.typingAt)
        void this.o.port.setTyping({ chatId: dmChatId(m.userId), typing: false });
      return;
    }
    if (marks) {
      marks.detectAt = Date.now();
      this.o.log.info(
        {
          userId: m.userId,
          mark: 't_detect',
          ms: marks.detectAt - marks.receivedAt,
          lagMs: marks.lagMs,
        },
        'timing',
      );
    }
    // An answered "which crew?" already names the crew: never ask twice.
    const chatId = resolvedPick ? m.chatId : await this.pickCrew(m, text);
    if (!chatId) return;
    this.inflight = marks ?? null;
    const result = await this.o.engine
      .handleIntent({
        chatId,
        userId: m.userId,
        messageId: m.messageId,
        text,
        at: m.at,
      })
      .finally(() => {
        this.inflight = null;
      });
    if (result.planId && marks && !this.planMarks.has(result.planId)) {
      this.planMarks.set(result.planId, marks);
    } else if (!result.planId && marks?.typingAt) {
      void this.o.port.setTyping({ chatId: dmChatId(m.userId), typing: false });
    }
  }

  private async onReaction(r: {
    messageId: string;
    userId: string;
    emoji: string;
    removed: boolean;
    at: string;
  }): Promise<void> {
    const bundle = this.o.bundles.byHeadcountMessage(r.messageId);
    if (!bundle) return;
    const stance = r.removed ? 'out' : stanceFromEmoji(r.emoji);
    if (stance === 'unclear') return;
    await this.o.engine.handleHeadcount({
      planId: bundle.planId,
      userId: r.userId,
      in: stance === 'in',
      at: r.at,
    });
    await this.recordHeadcount(bundle.planId, r.userId, stance === 'in');
    this.o.log.info(
      { planId: bundle.planId, userId: r.userId, stance, via: 'tapback' },
      'headcount',
    );
  }

  private async onPollVote(v: {
    pollId: string;
    userId: string;
    choices: string[];
    at: string;
  }): Promise<void> {
    const bundle = this.o.bundles.byPollId(v.pollId);
    if (!bundle) return;
    await this.o.engine.handleVote({
      planId: bundle.planId,
      pollId: v.pollId,
      userId: v.userId,
      choices: v.choices,
      at: v.at,
    });
  }

  // -- decisions -------------------------------------------------------------

  /** Rules decide strong and none; Haiku decides weak; rules fall back when Haiku is unavailable. */
  /**
   * In one crew: that crew. In several: the one the message names, else ask "which crew?" and
   * hold the message until they answer (crewPick resolves the answer). Returns null while waiting.
   */
  private async pickCrew(
    m: { chatId: string; userId: string; messageId: string; text: string; at: string },
    text: string,
  ): Promise<string | null> {
    const crews =
      (await this.o.crews?.crewsOf(m.userId))?.filter((c) => c.status === 'active') ?? [];
    if (crews.length <= 1) return m.chatId;
    const named = crews.find((c) => new RegExp(`\\b${escapeRegExp(c.name)}\\b`, 'i').test(text));
    if (named) return named.chatId;
    this.pendingPicks.set(m.userId, {
      text,
      chatId: null,
      crews: crews.map((c) => ({ name: c.name, chatId: c.chatId })),
      expiresAt: Date.now() + 10 * 60_000,
    });
    const list = crews.map((c, i) => `${i + 1}) ${c.name}`).join('  ');
    await this.o.port.sendPrivateText({
      userId: m.userId,
      text: `Which crew? ${list}`,
      idempotencyKey: idempotencyKey('crewpick', m.messageId),
    });
    this.o.log.info({ userId: m.userId, crews: crews.length }, 'asked which crew');
    return null;
  }

  /** The adapter asks: does this text answer an open "which crew?" Returns the crew chat id. */
  crewPick(userId: string, text: string): string | null {
    const pending = this.pendingPicks.get(userId);
    if (!pending) return null;
    if (pending.expiresAt < Date.now()) {
      this.pendingPicks.delete(userId);
      return null;
    }
    const t = text.trim().toLowerCase();
    const byNumber = /^\d+$/.test(t) ? pending.crews[Number(t) - 1] : undefined;
    const byName = pending.crews.find((c) => t.includes(c.name.toLowerCase()));
    const hit = byNumber ?? byName;
    if (!hit) return null;
    pending.chatId = hit.chatId;
    return hit.chatId;
  }

  private async isPlanIntent(text: string): Promise<boolean> {
    const detection = detectPlan(text);
    if (detection.level === 'strong') return true;
    if (detection.level === 'none') return false;
    const judgement = await this.o.classifier?.intent(text, {
      today: this.today(),
      timezone: this.timezone,
    });
    if (judgement)
      return judgement.isPlanIntent && judgement.confidence >= (this.o.minConfidence ?? 0.6);
    return text.includes('?');
  }

  private async rsvpStance(
    text: string,
    organizer: string,
    meal: string | null,
  ): Promise<RsvpStance> {
    const rule = parseRsvp(text);
    if (
      rule !== 'unclear' ||
      isQuestion(text) ||
      text.length > 120 ||
      detectPlan(text).level === 'strong'
    ) {
      return rule;
    }
    const judgement = await this.o.classifier?.rsvp(text, {
      planSummary: `${organizer} is planning ${meal ?? 'a meal'}`,
    });
    return judgement && judgement.confidence >= 0.8 ? judgement.stance : 'unclear';
  }

  private today(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone }).format(this.now());
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
