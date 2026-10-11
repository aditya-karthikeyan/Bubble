/**
 * The question bundle: what every crew member gets when a plan starts, in stages so nobody is
 * asked anything until the plan is actually happening.
 *
 *   1. Headcount line, right away: "Pranav's making a plan for dinner tonight. Tap 👍 on this
 *      message if you're in."
 *   2. Cuisine poll, once enough people are in (MIN_PARTY_SIZE, the organizer counts), and only
 *      when the engine's question policy asks for one.
 *   3. Live page link, when deliberation starts (sent by LiveSurfaces on DELIBERATING).
 *
 * MESSAGING_BUNDLE_MODE=all_at_once sends all three immediately (the Phase 2 behavior).
 *
 * The engine decides what to ask (QuestionDecision); this renders it through the MessagingPort
 * and remembers which logical messages and polls belong to which plan, so 👍 tapbacks, RSVP
 * replies, and votes route back to the right plan.
 */
import type Database from 'better-sqlite3';
import {
  MIN_PARTY_SIZE,
  idempotencyKey,
  type IsoDateTime,
  type MealKind,
  type MessagingPort,
  type PollOption,
} from '@bubbleworks/shared';

export type BundleMode = 'staged' | 'all_at_once';

export interface QuestionDecision {
  planId: string;
  /** Crew chat id, "crew:<groupId>". */
  chatId: string;
  /** Who started the plan, shown in the headcount line. */
  organizerName: string;
  meal: MealKind | null;
  /** 0 = today, 1 = tomorrow. */
  dayOffset?: 0 | 1;
  /** Null when the engine's question policy skips the cuisine question. */
  cuisinePoll: { pollId: string; question?: string; options: PollOption[] } | null;
  /**
   * Several questions in order, e.g. ["Sit-down or fast food?", cuisine]. The first goes out
   * once enough people are in; each next one when the engine closes the previous poll. When set,
   * it replaces cuisinePoll.
   */
  polls?: Array<{ pollId: string; question?: string; options: PollOption[] }>;
  /**
   * P1's style question ("Sit-down or fast food?", keys sit_down / fast_food). Asked before the
   * cuisine poll; ignored when `polls` is given.
   */
  stylePoll?: { pollId: string; question?: string; options: PollOption[] } | null;
  headcount: {
    closesAt: IsoDateTime;
    timezone: string;
    /**
     * opt_in (default): "Tap 👍 if you're in." opt_out: everyone counts as in unless they say
     * "out", so nobody has to tap anything. The engine decides which one it counts.
     */
    mode?: 'opt_in' | 'opt_out';
  };
  /** Live page, https://.../p/<token>. Null skips the link. */
  pageUrl: string | null;
}

export interface BundleResult {
  headcountMessageId: string;
  pollMessageId: string | null;
  linkMessageId: string | null;
  /** Bundle start to poll sent, when the poll went out with the bundle. */
  pollMs: number | null;
  /** Bundle start to everything this call sent. */
  ms: number;
}

type PendingPoll = NonNullable<QuestionDecision['cuisinePoll']>;

/** pending_poll holds a JSON array (older rows: one object). */
function parsePolls(raw: string | null): PendingPoll[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as PendingPoll | PendingPoll[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export interface BundleRecord {
  planId: string;
  chatId: string;
  headcountMessageId: string;
  pollId: string | null;
  organizerName: string;
  meal: MealKind | null;
  closesAt: IsoDateTime;
  /** When the headcount line went out; iMessage only allows edits for 15 minutes. */
  createdAt?: IsoDateTime;
  /** Staged bundles: the poll waiting for enough people, and the link waiting for deliberation. */
  /** Questions to ask, in order (staged). */
  pendingPolls?: PendingPoll[];
  /** Index of the next poll to send. */
  pollIndex?: number;
  pageUrl?: string | null;
  pollSent?: boolean;
  linkSent?: boolean;
  closed?: boolean;
}

export class BundleStore {
  constructor(private readonly sqlite: Database.Database) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS p2_bundles (
        plan_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        headcount_message_id TEXT NOT NULL,
        poll_id TEXT,
        organizer_name TEXT NOT NULL,
        meal TEXT,
        closes_at TEXT NOT NULL,
        closed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS p2_bundles_chat ON p2_bundles (chat_id, closed);
      CREATE TABLE IF NOT EXISTS p2_bundle_polls (
        poll_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS p2_bundle_in (
        plan_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (plan_id, user_id)
      );
    `);
    // Columns added for staged bundles; existing databases (Railway's volume) get them here.
    const have = new Set(
      (sqlite.prepare('PRAGMA table_info(p2_bundles)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    for (const [name, type] of [
      ['pending_poll', 'TEXT'],
      ['page_url', 'TEXT'],
      ['poll_sent', 'INTEGER NOT NULL DEFAULT 0'],
      ['poll_index', 'INTEGER NOT NULL DEFAULT 0'],
      ['link_sent', 'INTEGER NOT NULL DEFAULT 0'],
    ] as const) {
      if (!have.has(name)) sqlite.exec(`ALTER TABLE p2_bundles ADD COLUMN ${name} ${type}`);
    }
  }

  save(record: BundleRecord): void {
    this.sqlite
      .prepare(
        `INSERT OR REPLACE INTO p2_bundles
           (plan_id, chat_id, headcount_message_id, poll_id, organizer_name, meal, closes_at,
            created_at, pending_poll, page_url, poll_sent, link_sent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.planId,
        record.chatId,
        record.headcountMessageId,
        record.pollId,
        record.organizerName,
        record.meal,
        record.closesAt,
        new Date().toISOString(),
        record.pendingPolls?.length ? JSON.stringify(record.pendingPolls) : null,
        record.pageUrl ?? null,
        record.pollSent ? 1 : 0,
        record.linkSent ? 1 : 0,
      );
  }

  private one(where: string, value: string): BundleRecord | null {
    const row = this.sqlite
      .prepare(`SELECT * FROM p2_bundles WHERE ${where} ORDER BY rowid DESC LIMIT 1`)
      .get(value) as Record<string, string | number | null> | undefined;
    if (!row) return null;
    const str = (k: string) => (row[k] as string | null) ?? null;
    return {
      planId: str('plan_id')!,
      chatId: str('chat_id')!,
      headcountMessageId: str('headcount_message_id')!,
      pollId: str('poll_id'),
      organizerName: str('organizer_name')!,
      meal: (str('meal') as MealKind | null) ?? null,
      closesAt: str('closes_at')!,
      createdAt: str('created_at')!,
      pendingPolls: parsePolls(str('pending_poll')),
      pollIndex: (row['poll_index'] as number | null) ?? 0,
      pageUrl: str('page_url'),
      pollSent: row['poll_sent'] === 1,
      linkSent: row['link_sent'] === 1,
      closed: row['closed'] === 1,
    };
  }

  /** The plan's bundle even after it stopped collecting answers (for the live card). */
  byPlan(planId: string): BundleRecord | null {
    return this.one('plan_id = ?', planId);
  }

  byHeadcountMessage(messageId: string): BundleRecord | null {
    return this.one('headcount_message_id = ? AND closed = 0', messageId);
  }

  byPollId(pollId: string): BundleRecord | null {
    const row = this.sqlite
      .prepare('SELECT plan_id FROM p2_bundle_polls WHERE poll_id = ?')
      .get(pollId) as { plan_id: string } | undefined;
    if (row) {
      const bundle = this.byPlan(row.plan_id);
      return bundle && !bundle.closed ? bundle : null;
    }
    return this.one('poll_id = ? AND closed = 0', pollId);
  }

  /** The plan currently collecting answers in this crew. */
  openForChat(chatId: string): BundleRecord | null {
    return this.one('chat_id = ? AND closed = 0', chatId);
  }

  close(planId: string): void {
    this.sqlite.prepare('UPDATE p2_bundles SET closed = 1 WHERE plan_id = ?').run(planId);
  }

  /** Records a yes or no; returns how many are in now. */
  markIn(planId: string, userId: string, isIn: boolean): number {
    if (isIn) {
      this.sqlite
        .prepare('INSERT OR IGNORE INTO p2_bundle_in (plan_id, user_id) VALUES (?, ?)')
        .run(planId, userId);
    } else {
      this.sqlite
        .prepare('DELETE FROM p2_bundle_in WHERE plan_id = ? AND user_id = ?')
        .run(planId, userId);
    }
    return this.inCount(planId);
  }

  inCount(planId: string): number {
    const row = this.sqlite
      .prepare('SELECT COUNT(*) AS n FROM p2_bundle_in WHERE plan_id = ?')
      .get(planId) as { n: number };
    return row.n;
  }

  /** Flips link_sent once; true only for the caller that flipped it. */
  claim(planId: string, what: 'link'): boolean {
    const result = this.sqlite
      .prepare(`UPDATE p2_bundles SET link_sent = 1 WHERE plan_id = ? AND link_sent = 0`)
      .run(planId);
    return result.changes === 1 && what === 'link';
  }

  /** Moves poll_index from `index` to `index + 1` once; true only for the caller that moved it. */
  claimPoll(planId: string, index: number): boolean {
    const result = this.sqlite
      .prepare(
        'UPDATE p2_bundles SET poll_index = ?, poll_sent = 1 WHERE plan_id = ? AND poll_index = ?',
      )
      .run(index + 1, planId, index);
    return result.changes === 1;
  }

  registerPoll(pollId: string, planId: string): void {
    this.sqlite
      .prepare('INSERT OR REPLACE INTO p2_bundle_polls (poll_id, plan_id) VALUES (?, ?)')
      .run(pollId, planId);
  }
}

/** The questions to ask, in order: an explicit list, or style (if any) then cuisine (if any). */
export function pollSequence(decision: QuestionDecision): PendingPoll[] {
  if (decision.polls?.length) return decision.polls;
  return [decision.stylePoll, decision.cuisinePoll].filter((p): p is PendingPoll => !!p);
}

/** "7:05" in the crew's timezone. */
export function clockTime(iso: IsoDateTime, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  })
    .format(new Date(iso))
    .replace(/\s?[AP]M$/, '');
}

export function headcountText(decision: QuestionDecision): string {
  const when =
    decision.dayOffset === 1 ? 'tomorrow' : decision.meal === 'dinner' ? 'tonight' : 'today';
  const what = decision.meal ?? 'food';
  const closes = clockTime(decision.headcount.closesAt, decision.headcount.timezone);
  if (decision.headcount.mode === 'opt_out') {
    return `🫧 ${decision.organizerName}'s making a plan for ${what} ${when}. You're counted in, reply "out" if you can't make it. Locking it in at ${closes}.`;
  }
  return `${decision.organizerName}'s making a plan for ${what} ${when}. Tap 👍 on this message if you're in.`;
}

const key = (planId: string, part: string) => idempotencyKey(planId, 'bundle', part);

/**
 * Stage 1 (and, in all_at_once mode, everything). organizerUserId counts as in from the start,
 * since they asked.
 */
export async function renderBundle(
  port: Pick<MessagingPort, 'sendGroupText' | 'sendPoll' | 'sendRichLink'>,
  store: BundleStore,
  decision: QuestionDecision,
  options: { mode?: BundleMode; organizerUserId?: string | null } = {},
): Promise<BundleResult> {
  const started = performance.now();
  const mode = options.mode ?? 'staged';
  const sequence = pollSequence(decision);

  const headcount = await port.sendGroupText({
    chatId: decision.chatId,
    text: headcountText(decision),
    idempotencyKey: key(decision.planId, 'headcount'),
  });
  // Save before anything else goes out, so an early 👍 or "I'm in" already routes to the plan.
  store.save({
    planId: decision.planId,
    chatId: decision.chatId,
    headcountMessageId: headcount.messageId,
    pollId: sequence[0]?.pollId ?? null,
    organizerName: decision.organizerName,
    meal: decision.meal,
    closesAt: decision.headcount.closesAt,
    pendingPolls: sequence,
    pageUrl: decision.pageUrl,
  });
  if (options.organizerUserId) store.markIn(decision.planId, options.organizerUserId, true);
  for (const p of sequence) {
    store.registerPoll(p.pollId, decision.planId);
  }

  if (mode === 'staged') {
    return {
      headcountMessageId: headcount.messageId,
      pollMessageId: null,
      linkMessageId: null,
      pollMs: null,
      ms: Math.round(performance.now() - started),
    };
  }

  // all_at_once: poll wave, then link wave (slow link cards must not delay anyone's poll).
  const poll = (await maybeSendPoll(port, store, decision.planId, { force: true })) ?? null;
  const pollMs = poll ? Math.round(performance.now() - started) : null;
  const link = (await sendLiveLink(port, store, decision.planId)) ?? null;
  return {
    headcountMessageId: headcount.messageId,
    pollMessageId: poll,
    linkMessageId: link,
    pollMs,
    ms: Math.round(performance.now() - started),
  };
}

/**
 * Stage 2: the cuisine poll, once enough people are in. Returns the poll's message id when this
 * call sent it, null otherwise (no poll, not enough people yet, already sent, plan closed).
 */
async function sendPollAt(
  port: Pick<MessagingPort, 'sendPoll'>,
  store: BundleStore,
  bundle: BundleRecord,
  index: number,
): Promise<string | null> {
  const poll = bundle.pendingPolls?.[index];
  if (!poll || !store.claimPoll(bundle.planId, index)) return null;
  const sent = await port.sendPoll({
    chatId: bundle.chatId,
    planId: bundle.planId,
    pollId: poll.pollId,
    question:
      poll.question ??
      (poll.options.some((o) => o.key === 'sit_down')
        ? 'Sit-down or fast food?'
        : 'What are we eating?'),
    options: poll.options,
    // The first poll keeps Phase 2's key, so a redeploy mid-plan does not resend it.
    idempotencyKey: index === 0 ? key(bundle.planId, 'poll') : key(bundle.planId, `poll${index}`),
  });
  return sent.messageId;
}

/**
 * Stage 2: the first poll, once enough people are in. Returns the poll's message id when this
 * call sent it, null otherwise (no poll, not enough people yet, already sent, plan closed).
 */
export async function maybeSendPoll(
  port: Pick<MessagingPort, 'sendPoll'>,
  store: BundleStore,
  planId: string,
  options: { force?: boolean; minIn?: number } = {},
): Promise<string | null> {
  const bundle = store.byPlan(planId);
  if (!bundle?.pendingPolls?.length || (bundle.pollIndex ?? 0) > 0 || bundle.closed) return null;
  if (!options.force && store.inCount(planId) < (options.minIn ?? MIN_PARTY_SIZE)) return null;
  return sendPollAt(port, store, bundle, 0);
}

/**
 * The engine closed a poll: send the next question in the plan's sequence, if any (e.g. cuisine
 * after "sit-down or fast food?"). Returns the next poll's message id when this call sent it.
 */
export async function advancePolls(
  port: Pick<MessagingPort, 'sendPoll'>,
  store: BundleStore,
  closedPollId: string,
): Promise<string | null> {
  const bundle = store.byPollId(closedPollId) ?? null;
  if (!bundle?.pendingPolls?.length) return null;
  const index = bundle.pollIndex ?? 0;
  const previous = bundle.pendingPolls[index - 1];
  if (!previous || previous.pollId !== closedPollId) return null;
  return sendPollAt(port, store, bundle, index);
}

/** Stage 3: the live page link, once. Returns its message id when this call sent it. */
export async function sendLiveLink(
  port: Pick<MessagingPort, 'sendRichLink'>,
  store: BundleStore,
  planId: string,
): Promise<string | null> {
  const bundle = store.byPlan(planId);
  if (!bundle?.pageUrl || bundle.linkSent) return null;
  if (!store.claim(planId, 'link')) return null;
  const sent = await port.sendRichLink({
    chatId: bundle.chatId,
    url: bundle.pageUrl,
    title: 'Watch the bubbles decide',
    idempotencyKey: key(planId, 'link'),
  });
  return sent.messageId;
}
