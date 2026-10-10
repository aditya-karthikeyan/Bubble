/**
 * Messaging state in SQLite, in p2_* tables owned by P2. Survives restarts, so a retry after a
 * crash reuses the same idempotency key and nothing is sent twice.
 *
 * Logical messages: a crew send goes out as one copy per member, but the engine gets one
 * messageId back. p2_messages maps every provider copy to its logical id and chat, so a 👍 or
 * a threaded reply on any member's copy comes back as the id the engine knows.
 */
import type Database from 'better-sqlite3';
import type { PollOption } from '@bubbleworks/shared';

export interface OutboxRow {
  key: string;
  userId: string;
  status: 'pending' | 'sent' | 'failed';
  providerMessageId: string | null;
  attempts: number;
}

export interface MessageCopy {
  providerMessageId: string;
  logicalId: string;
  /** Crew chat id ("crew:<groupId>") or private chat id ("dm:<userId>"). */
  chatId: string;
  userId: string;
}

export interface PollRecord {
  pollId: string;
  chatId: string;
  options: PollOption[];
}

export class MessagingStore {
  constructor(private readonly sqlite: Database.Database) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS p2_outbox (
        key TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_message_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE TABLE IF NOT EXISTS p2_inbound_seen (
        provider_id TEXT PRIMARY KEY,
        seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS p2_messages (
        provider_message_id TEXT PRIMARY KEY,
        logical_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS p2_messages_logical ON p2_messages (logical_id);
      CREATE TABLE IF NOT EXISTS p2_polls (
        poll_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        options TEXT NOT NULL,
        closed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS p2_poll_messages (
        provider_message_id TEXT PRIMARY KEY,
        poll_id TEXT NOT NULL,
        user_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS p2_poll_votes (
        poll_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        option_key TEXT NOT NULL,
        PRIMARY KEY (poll_id, user_id, option_key)
      );
      CREATE TABLE IF NOT EXISTS p2_live_cards (
        plan_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        provider_message_id TEXT NOT NULL,
        PRIMARY KEY (plan_id, user_id)
      );
    `);
  }

  // -- outbox ----------------------------------------------------------------

  outbox(key: string): OutboxRow | null {
    const row = this.sqlite
      .prepare(
        'SELECT key, user_id, status, provider_message_id, attempts FROM p2_outbox WHERE key = ?',
      )
      .get(key) as
      | {
          key: string;
          user_id: string;
          status: OutboxRow['status'];
          provider_message_id: string | null;
          attempts: number;
        }
      | undefined;
    if (!row) return null;
    return {
      key: row.key,
      userId: row.user_id,
      status: row.status,
      providerMessageId: row.provider_message_id,
      attempts: row.attempts,
    };
  }

  begin(key: string, userId: string): void {
    this.sqlite
      .prepare(
        `INSERT INTO p2_outbox (key, user_id, status, created_at) VALUES (?, ?, 'pending', ?)
         ON CONFLICT(key) DO UPDATE SET status = 'pending'`,
      )
      .run(key, userId, new Date().toISOString());
  }

  attempt(key: string): void {
    this.sqlite.prepare('UPDATE p2_outbox SET attempts = attempts + 1 WHERE key = ?').run(key);
  }

  sent(key: string, providerMessageId: string): void {
    this.sqlite
      .prepare(
        `UPDATE p2_outbox SET status = 'sent', provider_message_id = ?, sent_at = ?, error = NULL
         WHERE key = ?`,
      )
      .run(providerMessageId, new Date().toISOString(), key);
  }

  failed(key: string, error: string): void {
    this.sqlite
      .prepare(`UPDATE p2_outbox SET status = 'failed', error = ? WHERE key = ?`)
      .run(error.slice(0, 500), key);
  }

  // -- inbound dedupe --------------------------------------------------------

  /** True the first time a provider id is seen; false for duplicates and replays. */
  markSeen(providerId: string): boolean {
    const result = this.sqlite
      .prepare('INSERT OR IGNORE INTO p2_inbound_seen (provider_id, seen_at) VALUES (?, ?)')
      .run(providerId, new Date().toISOString());
    return result.changes === 1;
  }

  // -- logical messages ------------------------------------------------------

  recordCopy(copy: MessageCopy): void {
    this.sqlite
      .prepare(
        `INSERT OR REPLACE INTO p2_messages
           (provider_message_id, logical_id, chat_id, user_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        copy.providerMessageId,
        copy.logicalId,
        copy.chatId,
        copy.userId,
        new Date().toISOString(),
      );
  }

  copy(providerMessageId: string): MessageCopy | null {
    const row = this.sqlite
      .prepare('SELECT * FROM p2_messages WHERE provider_message_id = ?')
      .get(providerMessageId) as Record<string, string> | undefined;
    return row ? toCopy(row) : null;
  }

  copiesOf(logicalId: string): MessageCopy[] {
    const rows = this.sqlite
      .prepare('SELECT * FROM p2_messages WHERE logical_id = ?')
      .all(logicalId) as Array<Record<string, string>>;
    return rows.map(toCopy);
  }

  // -- polls -----------------------------------------------------------------

  savePoll(poll: PollRecord): void {
    this.sqlite
      .prepare('INSERT OR IGNORE INTO p2_polls (poll_id, chat_id, options) VALUES (?, ?, ?)')
      .run(poll.pollId, poll.chatId, JSON.stringify(poll.options));
  }

  poll(pollId: string): (PollRecord & { closed: boolean }) | null {
    const row = this.sqlite.prepare('SELECT * FROM p2_polls WHERE poll_id = ?').get(pollId) as
      { poll_id: string; chat_id: string; options: string; closed: number } | undefined;
    if (!row) return null;
    return {
      pollId: row.poll_id,
      chatId: row.chat_id,
      options: JSON.parse(row.options) as PollOption[],
      closed: row.closed === 1,
    };
  }

  /** Returns true the first time a poll is closed. */
  closePoll(pollId: string): boolean {
    const result = this.sqlite
      .prepare('UPDATE p2_polls SET closed = 1 WHERE poll_id = ? AND closed = 0')
      .run(pollId);
    return result.changes === 1;
  }

  savePollMessage(providerMessageId: string, pollId: string, userId: string): void {
    this.sqlite
      .prepare(
        'INSERT OR REPLACE INTO p2_poll_messages (provider_message_id, poll_id, user_id) VALUES (?, ?, ?)',
      )
      .run(providerMessageId, pollId, userId);
  }

  pollIdForMessage(providerMessageId: string): string | null {
    const row = this.sqlite
      .prepare('SELECT poll_id FROM p2_poll_messages WHERE provider_message_id = ?')
      .get(providerMessageId) as { poll_id: string } | undefined;
    return row?.poll_id ?? null;
  }

  /** Newest poll sent to this member, for votes whose id carries no poll message id. */
  latestPollIdFor(userId: string): string | null {
    const row = this.sqlite
      .prepare('SELECT poll_id FROM p2_poll_messages WHERE user_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(userId) as { poll_id: string } | undefined;
    return row?.poll_id ?? null;
  }

  /** Applies one vote delta and returns the voter's full current selection. */
  applyVote(pollId: string, userId: string, optionKey: string, selected: boolean): string[] {
    if (selected) {
      this.sqlite
        .prepare(
          'INSERT OR IGNORE INTO p2_poll_votes (poll_id, user_id, option_key) VALUES (?, ?, ?)',
        )
        .run(pollId, userId, optionKey);
    } else {
      this.sqlite
        .prepare('DELETE FROM p2_poll_votes WHERE poll_id = ? AND user_id = ? AND option_key = ?')
        .run(pollId, userId, optionKey);
    }
    return this.choices(pollId, userId);
  }

  choices(pollId: string, userId: string): string[] {
    const rows = this.sqlite
      .prepare(
        'SELECT option_key FROM p2_poll_votes WHERE poll_id = ? AND user_id = ? ORDER BY option_key',
      )
      .all(pollId, userId) as Array<{ option_key: string }>;
    return rows.map((r) => r.option_key);
  }

  /** Votes per option key across every voter. */
  tally(pollId: string): Map<string, number> {
    const rows = this.sqlite
      .prepare(
        'SELECT option_key, COUNT(*) AS n FROM p2_poll_votes WHERE poll_id = ? GROUP BY option_key',
      )
      .all(pollId) as Array<{ option_key: string; n: number }>;
    return new Map(rows.map((r) => [r.option_key, r.n]));
  }

  // -- live cards ------------------------------------------------------------

  liveCard(planId: string, userId: string): string | null {
    const row = this.sqlite
      .prepare('SELECT provider_message_id FROM p2_live_cards WHERE plan_id = ? AND user_id = ?')
      .get(planId, userId) as { provider_message_id: string } | undefined;
    return row?.provider_message_id ?? null;
  }

  setLiveCard(planId: string, userId: string, providerMessageId: string): void {
    this.sqlite
      .prepare(
        'INSERT OR REPLACE INTO p2_live_cards (plan_id, user_id, provider_message_id) VALUES (?, ?, ?)',
      )
      .run(planId, userId, providerMessageId);
  }
}

function toCopy(row: Record<string, string>): MessageCopy {
  return {
    providerMessageId: row['provider_message_id']!,
    logicalId: row['logical_id']!,
    chatId: row['chat_id']!,
    userId: row['user_id']!,
  };
}
