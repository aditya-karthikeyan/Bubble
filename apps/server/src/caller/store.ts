/**
 * Caller state in SQLite, in p4_* tables owned by P4. One row per phone call: a booking's
 * primary venue and its backup are two rows. Survives restarts, so polling resumes and a
 * repeated idempotency key or a redelivered webhook never dials or reports twice.
 */
import type Database from 'better-sqlite3';
import type { BookRequest, CallOutcome } from '@bubbleworks/shared';

export type CallAttempt = 'primary' | 'backup';
export type CallRowStatus = 'dialing' | 'talking' | 'finished';

export interface CallRow {
  callId: string;
  idempotencyKey: string;
  planId: string;
  bookingId: string;
  attempt: CallAttempt;
  venueId: string;
  request: BookRequest;
  conversationId: string | null;
  status: CallRowStatus;
  outcome: CallOutcome | null;
}

interface RawRow {
  call_id: string;
  idem_key: string;
  plan_id: string;
  booking_id: string;
  attempt: CallAttempt;
  venue_id: string;
  request_json: string;
  conversation_id: string | null;
  status: CallRowStatus;
  outcome: CallOutcome | null;
}

function toRow(r: RawRow): CallRow {
  return {
    callId: r.call_id,
    idempotencyKey: r.idem_key,
    planId: r.plan_id,
    bookingId: r.booking_id,
    attempt: r.attempt,
    venueId: r.venue_id,
    request: JSON.parse(r.request_json) as BookRequest,
    conversationId: r.conversation_id,
    status: r.status,
    outcome: r.outcome,
  };
}

export class CallerStore {
  constructor(private readonly sqlite: Database.Database) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS p4_calls (
        call_id TEXT PRIMARY KEY,
        idem_key TEXT NOT NULL UNIQUE,
        plan_id TEXT NOT NULL,
        booking_id TEXT NOT NULL,
        attempt TEXT NOT NULL,
        venue_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        conversation_id TEXT UNIQUE,
        status TEXT NOT NULL,
        outcome TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  insert(row: Omit<CallRow, 'conversationId' | 'status' | 'outcome'>): CallRow {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO p4_calls (call_id, idem_key, plan_id, booking_id, attempt, venue_id, request_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'dialing', ?, ?)`,
      )
      .run(
        row.callId,
        row.idempotencyKey,
        row.planId,
        row.bookingId,
        row.attempt,
        row.venueId,
        JSON.stringify(row.request),
        now,
        now,
      );
    return { ...row, conversationId: null, status: 'dialing', outcome: null };
  }

  byKey(idempotencyKey: string): CallRow | null {
    const r = this.sqlite
      .prepare('SELECT * FROM p4_calls WHERE idem_key = ?')
      .get(idempotencyKey) as RawRow | undefined;
    return r ? toRow(r) : null;
  }

  byConversation(conversationId: string): CallRow | null {
    const r = this.sqlite
      .prepare('SELECT * FROM p4_calls WHERE conversation_id = ?')
      .get(conversationId) as RawRow | undefined;
    return r ? toRow(r) : null;
  }

  /** Calls still on the line (or ringing) that have a conversation to watch. */
  live(): CallRow[] {
    return (
      this.sqlite
        .prepare(
          "SELECT * FROM p4_calls WHERE status != 'finished' AND conversation_id IS NOT NULL",
        )
        .all() as RawRow[]
    ).map(toRow);
  }

  setConversation(callId: string, conversationId: string): void {
    this.sqlite
      .prepare('UPDATE p4_calls SET conversation_id = ?, updated_at = ? WHERE call_id = ?')
      .run(conversationId, new Date().toISOString(), callId);
  }

  /** dialing -> talking. False when the call already moved on. */
  markTalking(callId: string): boolean {
    return (
      this.sqlite
        .prepare(
          "UPDATE p4_calls SET status = 'talking', updated_at = ? WHERE call_id = ? AND status = 'dialing'",
        )
        .run(new Date().toISOString(), callId).changes === 1
    );
  }

  /**
   * Claim the call's result. Synchronous, so exactly one of the webhook and the poller wins;
   * the loser gets false and does nothing.
   */
  finish(callId: string, outcome: CallOutcome): boolean {
    return (
      this.sqlite
        .prepare(
          "UPDATE p4_calls SET status = 'finished', outcome = ?, updated_at = ? WHERE call_id = ? AND status != 'finished'",
        )
        .run(outcome, new Date().toISOString(), callId).changes === 1
    );
  }
}
