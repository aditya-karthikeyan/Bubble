/**
 * The question bundle: what every crew member gets when a plan starts.
 *
 *   1. Headcount line: "🫧 Pranav is planning dinner tonight. Tap 👍 on this message if you're
 *      in. Voting closes 7:05."
 *   2. Cuisine poll, only when the engine's question policy asks for one.
 *   3. Live page link (rich link), when the plan has a page.
 *
 * The engine decides what to ask (QuestionDecision); this renders it through the MessagingPort
 * and remembers which logical messages and polls belong to which plan, so 👍 tapbacks, RSVP
 * replies, and votes route back to the right plan.
 */
import type Database from 'better-sqlite3';
import {
  idempotencyKey,
  type IsoDateTime,
  type MealKind,
  type MessagingPort,
  type PollOption,
} from '@bubbleworks/shared';

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
  headcount: { closesAt: IsoDateTime; timezone: string };
  /** Live page, https://.../p/<token>. Null skips the link. */
  pageUrl: string | null;
}

export interface BundleResult {
  headcountMessageId: string;
  pollMessageId: string | null;
  linkMessageId: string | null;
  /** Bundle start to poll sent, when there was a poll. */
  pollMs: number | null;
  /** Bundle start to everything sent. */
  ms: number;
}

export interface BundleRecord {
  planId: string;
  chatId: string;
  headcountMessageId: string;
  pollId: string | null;
  organizerName: string;
  meal: MealKind | null;
  closesAt: IsoDateTime;
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
    `);
  }

  save(record: BundleRecord): void {
    this.sqlite
      .prepare(
        `INSERT OR REPLACE INTO p2_bundles
           (plan_id, chat_id, headcount_message_id, poll_id, organizer_name, meal, closes_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
  }

  private one(where: string, value: string): BundleRecord | null {
    const row = this.sqlite
      .prepare(`SELECT * FROM p2_bundles WHERE ${where} ORDER BY rowid DESC LIMIT 1`)
      .get(value) as Record<string, string | null> | undefined;
    if (!row) return null;
    return {
      planId: row['plan_id']!,
      chatId: row['chat_id']!,
      headcountMessageId: row['headcount_message_id']!,
      pollId: row['poll_id'] ?? null,
      organizerName: row['organizer_name']!,
      meal: (row['meal'] as MealKind | null) ?? null,
      closesAt: row['closes_at']!,
    };
  }

  byHeadcountMessage(messageId: string): BundleRecord | null {
    return this.one('headcount_message_id = ? AND closed = 0', messageId);
  }

  byPollId(pollId: string): BundleRecord | null {
    return this.one('poll_id = ? AND closed = 0', pollId);
  }

  /** The plan currently collecting answers in this crew. */
  openForChat(chatId: string): BundleRecord | null {
    return this.one('chat_id = ? AND closed = 0', chatId);
  }

  close(planId: string): void {
    this.sqlite.prepare('UPDATE p2_bundles SET closed = 1 WHERE plan_id = ?').run(planId);
  }
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
  const what = decision.meal ?? 'something';
  const closes = clockTime(decision.headcount.closesAt, decision.headcount.timezone);
  return `🫧 ${decision.organizerName} is planning ${what} ${when}. Tap 👍 on this message if you're in. Voting closes ${closes}.`;
}

export async function renderBundle(
  port: MessagingPort,
  store: BundleStore,
  decision: QuestionDecision,
): Promise<BundleResult> {
  const started = performance.now();
  const key = (part: string) => idempotencyKey(decision.planId, 'bundle', part);

  const headcount = await port.sendGroupText({
    chatId: decision.chatId,
    text: headcountText(decision),
    idempotencyKey: key('headcount'),
  });
  // Save before the poll goes out, so an early 👍 or "I'm in" already routes to the plan.
  store.save({
    planId: decision.planId,
    chatId: decision.chatId,
    headcountMessageId: headcount.messageId,
    pollId: decision.cuisinePoll?.pollId ?? null,
    organizerName: decision.organizerName,
    meal: decision.meal,
    closesAt: decision.headcount.closesAt,
  });

  // Poll and link go out together: the rich link takes ~2.6 s on Photon (preview fetch), so
  // waiting on it would push the bundle past 5 s. The poll still lands first in practice.
  let pollMs: number | null = null;
  const [poll, link] = await Promise.all([
    decision.cuisinePoll
      ? port
          .sendPoll({
            chatId: decision.chatId,
            planId: decision.planId,
            pollId: decision.cuisinePoll.pollId,
            question: decision.cuisinePoll.question ?? 'What are we eating?',
            options: decision.cuisinePoll.options,
            idempotencyKey: key('poll'),
          })
          .then((r) => {
            pollMs = Math.round(performance.now() - started);
            return r;
          })
      : null,
    decision.pageUrl
      ? port.sendRichLink({
          chatId: decision.chatId,
          url: decision.pageUrl,
          title: 'Watch the bubbles decide',
          idempotencyKey: key('link'),
        })
      : null,
  ]);

  return {
    headcountMessageId: headcount.messageId,
    pollMessageId: poll?.messageId ?? null,
    linkMessageId: link?.messageId ?? null,
    pollMs,
    ms: Math.round(performance.now() - started),
  };
}
