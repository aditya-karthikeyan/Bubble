/**
 * PlanIntake: inbound messaging -> PlanEngine, and the engine's question decision -> the bundle.
 *
 *   text arrives     -> plan words? typing bubble in the sender's DM right away (pre-batch)
 *   group message    -> open plan in that crew? parse RSVP (rules, then Haiku) -> handleHeadcount
 *                       else an open plan question waiting on them? the text answers it
 *                       else detect (rules; Haiku for weak) -> plan draft -> handleIntent
 *                       else not a plan: handed to the private handler (the bubble answers)
 *   plan draft       -> crew not named, or no cuisine: ONE private question for what's missing
 *                       ("Yeah fasho 🫧 Which crew, and what are we feeling?"), the reply fills
 *                       it in, one re-ask at most, then handleIntent with the crew and cuisine
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
  isProposal,
  isQuestion,
  parsePlanCommand,
  parseRsvp,
  stanceFromEmoji,
  type RsvpStance,
} from './detect.js';
import type { AuditLog } from './safety.js';
import { parseCuisine } from '../engine/intent.js';

export interface PlanIntakeOptions {
  port: SpectrumMessaging;
  engine: PlanEngine;
  bundles: BundleStore;
  classifier: Classifier | null;
  log: Logger;
  /** Crew lookup for the "which crew?" question. Without it the adapter's route is the crew. */
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
  /**
   * True when the bubble owns this DM even while a plan is in flight ("I covered dinner", or
   * the bill total it asked for), so it is handed over instead of read as a plan or a command.
   */
  claimsDm?: (userId: string, text: string) => boolean;
}

interface Marks {
  receivedAt: number;
  lagMs: number;
  userId: string;
  typingAt?: number;
  detectAt?: number;
}

/** A plan message waiting on its organizer's answer: which crew, what cuisine. */
interface PlanDraft {
  /** The plan message as sent; a later full plan message replaces it. */
  text: string;
  /** Their active crews, in directory order. */
  crews: Array<{ name: string; chatId: string }>;
  /** Null until the message names a crew or they answer which one. */
  chatId: string | null;
  /** Where the adapter routed the message, for answers when no crew is known yet. */
  routeChatId: string;
  cuisine: string | null;
  /** Free-form answer to "what are we feeling?" that names no cuisine key ("pho"). */
  taste: string | null;
  /** True once a cuisine, a free-form taste, or "anything" is in. */
  cuisineSettled: boolean;
  /** Questions sent so far. */
  asks: number;
  expiresAt: number;
}

const DRAFT_TTL_MS = 10 * 60_000;
const NO_PREFERENCE =
  /\b(anything|whatever|idk|i don'?t know|dunno|surprise me|no pref(erence)?s?|don'?t care|dont care|up to you|you pick|dealer'?s choice|open|any ?thing works)\b/i;
const NEW_CREW = /^\s*(?:new|make|create|start)\s+(?:a\s+)?crew\b/i;
const NEW_CREW_NAMED =
  /^\s*(?:new|make|create|start)\s+(?:a\s+)?crew(?:\s+(?:called|named))?\s+\S/i;
const CUISINE_QUESTION =
  'Fasho 🫧 What are we feeling? (indian, chinese, mexican… or say anything)';

export class PlanIntake {
  /** Plan messages waiting on their organizer's answer, by user. */
  private readonly drafts = new Map<string, PlanDraft>();
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
    // The bubble's bill flow first: "never mind" there must not cancel the booked plan.
    if (this.o.claimsDm?.(m.userId, m.text)) {
      if (this.marks.get(m.userId)?.typingAt) {
        void this.o.port.setTyping({ chatId: dmChatId(m.userId), typing: false });
      }
      await this.handOff(m);
      return;
    }

    const open = this.o.bundles.openForChat(m.chatId);

    // "wait", "resume", "veto", "cancel", "why this place?" always reach the engine.
    const command = parsePlanCommand(m.text);
    if (command === 'cancel') this.drafts.delete(m.userId);
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
        // Logged on arrival: the engine call below can run the whole deliberation, so a line
        // written after it would land after the lock and read as a late answer.
        this.o.log.info(
          { planId: open.planId, userId: m.userId, stance, via: 'reply' },
          'headcount',
        );
        await this.o.engine.handleHeadcount({
          planId: open.planId,
          userId: m.userId,
          in: stance === 'in',
          at: m.at,
        });
        await this.recordHeadcount(open.planId, m.userId, stance === 'in');
        return;
      }
    }

    // Anything they send while a plan question waits on them is the answer.
    const draft = this.activeDraft(m.userId);
    if (draft) {
      await this.answerDraft(m, draft);
      return;
    }

    const marks = this.marks.get(m.userId);
    if (!(await this.isPlanIntent(m.text))) {
      if (marks?.typingAt)
        void this.o.port.setTyping({ chatId: dmChatId(m.userId), typing: false });
      // Not a plan after all: the bubble answers it rather than leaving it on read.
      await this.handOff(m);
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
    // A plan is already collecting answers in this crew: the engine joins it, no questions.
    if (open) {
      await this.startPlan(m, m.chatId, m.text);
      return;
    }
    const crews = await this.activeCrews(m.userId);
    const named = crews.find((c) => crewNamePattern(c.name).test(m.text));
    // The crew is known only when the message names it: one crew is not proof they meant it.
    const chatId = named?.chatId ?? (crews.length ? null : m.chatId);
    const cuisine = parseCuisine(m.text);
    if (chatId && cuisine) {
      await this.startPlan(m, chatId, m.text);
      return;
    }
    const fresh: PlanDraft = {
      text: m.text,
      crews,
      chatId,
      routeChatId: m.chatId,
      cuisine,
      taste: null,
      cuisineSettled: cuisine !== null,
      asks: 0,
      expiresAt: Date.now() + DRAFT_TTL_MS,
    };
    this.drafts.set(m.userId, fresh);
    await this.askDraft(m, fresh);
  }

  /** handleIntent with the crew and the merged text, and the timing marks for the bundle. */
  private async startPlan(
    m: { userId: string; messageId: string; at: string },
    chatId: string,
    text: string,
  ): Promise<void> {
    const marks = this.marks.get(m.userId);
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

  /** The message goes on to the private handlers (the bubble) instead of being dropped. */
  private async handOff(m: {
    userId: string;
    messageId: string;
    text: string;
    at: string;
  }): Promise<void> {
    await this.o.port.deliverPrivate({
      messageId: m.messageId,
      userId: m.userId,
      text: m.text,
      at: m.at,
    });
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
    // Logged on arrival, before the engine call that may deliberate and lock (see above).
    this.o.log.info(
      { planId: bundle.planId, userId: r.userId, stance, via: 'tapback' },
      'headcount',
    );
    await this.o.engine.handleHeadcount({
      planId: bundle.planId,
      userId: r.userId,
      in: stance === 'in',
      at: r.at,
    });
    await this.recordHeadcount(bundle.planId, r.userId, stance === 'in');
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

  // -- plan draft ------------------------------------------------------------

  private async activeCrews(userId: string): Promise<Array<{ name: string; chatId: string }>> {
    const crews = (await this.o.crews?.crewsOf(userId)) ?? [];
    return crews
      .filter((c) => c.status === 'active')
      .map((c) => ({ name: c.name, chatId: c.chatId }));
  }

  private activeDraft(userId: string): PlanDraft | null {
    const draft = this.drafts.get(userId);
    if (!draft) return null;
    if (draft.expiresAt < Date.now()) {
      this.drafts.delete(userId);
      return null;
    }
    return draft;
  }

  /**
   * The adapter asks: is a plan question waiting on this person? Then their next text is the
   * answer, routed to the crew already known, else the chat the plan message came in on.
   */
  pendingAnswer(userId: string): string | null {
    const draft = this.activeDraft(userId);
    return draft ? (draft.chatId ?? draft.routeChatId) : null;
  }

  /** One private question for whatever the draft is still missing. */
  private async askDraft(
    m: { userId: string; messageId: string },
    draft: PlanDraft,
  ): Promise<void> {
    const text = draftQuestion(draft);
    draft.asks += 1;
    draft.expiresAt = Date.now() + DRAFT_TTL_MS;
    if (this.marks.get(m.userId)?.typingAt) {
      void this.o.port.setTyping({ chatId: dmChatId(m.userId), typing: false });
    }
    await this.o.port.sendPrivateText({
      userId: m.userId,
      text,
      idempotencyKey: idempotencyKey('plandraft', m.messageId),
    });
    this.o.log.info(
      {
        userId: m.userId,
        crewMissing: draft.chatId === null,
        cuisineMissing: !draft.cuisineSettled,
        asks: draft.asks,
      },
      'plan draft question',
    );
  }

  /**
   * Their reply to the plan question. A number or crew name picks the crew; a cuisine word, or
   * "anything", settles the cuisine. One re-ask for what is still missing, then go with what we
   * have; a crew is never guessed unless they are in exactly one.
   */
  private async answerDraft(
    m: { chatId: string; userId: string; messageId: string; text: string; at: string },
    draft: PlanDraft,
  ): Promise<void> {
    // "new crew the lads": the bubble makes the crew and sends its join link; the plan waits.
    if (NEW_CREW.test(m.text)) {
      this.drafts.delete(m.userId);
      await this.handOff(m);
      if (NEW_CREW_NAMED.test(m.text)) {
        await this.o.port.sendPrivateText({
          userId: m.userId,
          text: "Once they've joined, tell me about dinner again.",
          idempotencyKey: idempotencyKey('plandraft', m.messageId, 'newcrew'),
        });
      }
      this.o.log.info({ userId: m.userId }, 'plan draft: new crew instead');
      return;
    }
    // A whole new plan message speaks for itself.
    if (detectPlan(m.text).level === 'strong') draft.text = m.text;

    const cuisineOnly = draft.chatId !== null && !draft.cuisineSettled;
    let crewHit: { name: string; chatId: string } | null = null;
    if (!draft.chatId) {
      crewHit = matchCrew(draft.crews, m.text);
      if (crewHit) draft.chatId = crewHit.chatId;
    }
    if (!draft.cuisineSettled) {
      const cuisine = parseCuisine(m.text);
      if (cuisine) {
        draft.cuisine = cuisine;
        draft.cuisineSettled = true;
      } else if (NO_PREFERENCE.test(m.text)) {
        draft.cuisineSettled = true;
      } else {
        // "pho" after "what are we feeling?" is a taste, even without a cuisine key for it.
        const rest = leftover(m.text, crewHit);
        if (rest && (cuisineOnly || crewHit)) {
          draft.taste = rest;
          draft.cuisineSettled = true;
        }
      }
    }
    // Already asked twice: no cuisine is fine, and a single crew is the crew.
    if (draft.asks >= 2) {
      draft.cuisineSettled = true;
      if (!draft.chatId && draft.crews.length === 1) draft.chatId = draft.crews[0]!.chatId;
    }

    if (draft.chatId && draft.cuisineSettled) {
      this.drafts.delete(m.userId);
      this.o.log.info(
        { userId: m.userId, cuisine: draft.cuisine, taste: draft.taste !== null },
        'plan draft complete',
      );
      await this.startPlan(m, draft.chatId, draftText(draft));
      return;
    }
    if (draft.asks >= 3) {
      this.drafts.delete(m.userId);
      await this.o.port.sendPrivateText({
        userId: m.userId,
        text: "No worries 🫧 Tell me about the plan again with the crew's name, like: dinner with the boys.",
        idempotencyKey: idempotencyKey('plandraft', m.messageId, 'giveup'),
      });
      this.o.log.info({ userId: m.userId }, 'plan draft dropped: crew never named');
      return;
    }
    await this.askDraft(m, draft);
  }

  // -- decisions -------------------------------------------------------------

  /** Rules decide strong and none; Haiku decides weak; rules fall back when Haiku is unavailable. */
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
    // Rules only: "i want to eat food w my friends" proposes; "so hungry" just reports.
    return text.includes('?') || isProposal(text);
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

/** "the boys" also matches "boys"; whole words only. */
function crewNamePattern(name: string): RegExp {
  const bare = name.replace(/^the\s+/i, '');
  return new RegExp(`\\b(?:the\\s+)?${escapeRegExp(bare)}\\b`, 'i');
}

/** "2", "2, indian", or a crew name anywhere in the reply. */
function matchCrew(
  crews: Array<{ name: string; chatId: string }>,
  text: string,
): { name: string; chatId: string } | null {
  const n = /^\s*(\d{1,2})(?!\d|\s*(?:am|pm|:))\b/i.exec(text)?.[1];
  const byNumber = n ? crews[Number(n) - 1] : undefined;
  return byNumber ?? crews.find((c) => crewNamePattern(c.name).test(text)) ?? null;
}

/** What is left of a reply once the crew pick is taken out, for a free-form taste. */
function leftover(text: string, crew: { name: string } | null): string {
  let rest = text;
  if (crew) rest = rest.replace(crewNamePattern(crew.name), ' ').replace(/^\s*\d{1,2}\b/, ' ');
  rest = rest
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/^\s*(?:and|with|w|feeling|we'?re feeling|maybe)\b/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return rest.length <= 40 ? rest : '';
}

/** The plan text handleIntent parses: the original message plus what the answers added. */
function draftText(draft: PlanDraft): string {
  if (draft.cuisine && parseCuisine(draft.text) !== draft.cuisine) {
    return `${draft.text} feeling ${draft.cuisine}`;
  }
  if (draft.taste) return `${draft.text} feeling ${draft.taste}`;
  return draft.text;
}

/** One question for everything missing, in the bubble's voice. */
function draftQuestion(draft: PlanDraft): string {
  const newCrew = 'Or say "new crew <name>" to make one.';
  if (draft.chatId === null && !draft.cuisineSettled) {
    const names = draft.crews.map((c) => c.name).join(', ');
    const example = draft.crews[0]?.name ?? 'the boys';
    return `Yeah fasho 🫧 Which crew, and what are we feeling? You're in: ${names}. ${newCrew} (like: ${example}, indian)`;
  }
  if (draft.chatId === null) {
    const list = draft.crews.map((c, i) => `${i + 1}) ${c.name}`).join('  ');
    return `Which crew? ${list}  Or "new crew <name>".`;
  }
  return CUISINE_QUESTION;
}
