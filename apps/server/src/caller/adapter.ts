/**
 * ElevenLabsCaller: the real CallerPort. book() dials the venue through the ElevenLabs agent on
 * Twilio; the post-call webhook (or the poller, when the webhook is late or missing) reports what
 * happened. No answer, voicemail, or a full house sends it to the backup venue automatically.
 * Exactly one CallResult reaches the engine per booking, and doer_status events narrate the call
 * on the live page with page-safe lines only (venue names, never phones, budgets, or diets).
 */
import {
  newId,
  type BookRequest,
  type CallHandle,
  type CallOutcome,
  type CallResult,
  type CallerPort,
  type DoerState,
  type EventBus,
  type Venue,
} from '@bubbleworks/shared';
import type { Logger } from '../events/bus.js';
import { DEMO_VENUE_PHONE_PLACEHOLDER } from '../venues/demo-venue.js';
import type { CallerConfig } from './config.js';
import {
  readConversation,
  readInitiationFailure,
  triesBackup,
  type CallRead,
  type WebhookEvent,
} from './conversation.js';
import type { ElevenLabsApi } from './elevenlabs.js';
import type { CallRow, CallerStore } from './store.js';
import { addMinutes, formatLocalTime, parseLocalTime } from './time.js';

export type CallResultSink = (result: CallResult) => Promise<void>;
export type WebhookOutcome = 'processed' | 'duplicate' | 'unmatched' | 'ignored';

/** The agent accepts any time from 30 minutes before to 60 minutes after the request. */
export const WINDOW_BEFORE_MIN = 30;
export const WINDOW_AFTER_MIN = 60;

export interface ElevenLabsCallerOptions {
  api: ElevenLabsApi;
  store: CallerStore;
  bus: Pick<EventBus, 'publish'>;
  onResult: CallResultSink;
  config: Pick<
    CallerConfig,
    | 'CALLER_ALLOWED_NUMBERS'
    | 'CALLER_RING_TIMEOUT_S'
    | 'CALLER_TIMEZONE'
    | 'CALLER_POLL_MS'
    | 'TWILIO_PHONE_NUMBER'
  >;
  log: Logger;
  now?: () => Date;
}

function outcomeFor(read: CallRead, row: CallRow): CallOutcome {
  switch (read.kind) {
    case 'booked':
      return row.attempt === 'primary' ? 'booked' : 'booked_backup';
    case 'needs_human':
      return 'needs_human';
    case 'full':
      return 'declined';
    case 'no_answer':
    case 'voicemail':
      return 'no_answer';
    default:
      return 'failed';
  }
}

function clip(line: string): string {
  return line.length <= 120 ? line : `${line.slice(0, 117)}...`;
}

export class ElevenLabsCaller implements CallerPort {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly now: () => Date;

  constructor(private readonly o: ElevenLabsCallerOptions) {
    this.now = o.now ?? (() => new Date());
  }

  /** Resume watching calls that were live before a restart. */
  start(): void {
    if (this.o.config.CALLER_POLL_MS > 0 && !this.timer) {
      this.timer = setInterval(() => void this.pollOnce(), this.o.config.CALLER_POLL_MS);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async book(request: BookRequest): Promise<CallHandle> {
    const seen = this.o.store.byKey(request.idempotencyKey);
    if (seen)
      return { callId: seen.callId, status: seen.status === 'talking' ? 'in_call' : 'dialing' };
    const row = this.o.store.insert({
      callId: newId('call'),
      idempotencyKey: request.idempotencyKey,
      planId: request.planId,
      bookingId: request.bookingId,
      attempt: 'primary',
      venueId: request.venue.id,
      request,
    });
    await this.dial(row, request.venue);
    return { callId: row.callId, status: 'dialing' };
  }

  async modify(): Promise<CallHandle> {
    throw new Error('ElevenLabsCaller.modify lands in P4 Phase 4');
  }

  async cancel(): Promise<CallHandle> {
    throw new Error('ElevenLabsCaller.cancel lands in P4 Phase 4');
  }

  async holdTable(): Promise<CallHandle> {
    throw new Error('ElevenLabsCaller.holdTable lands in P4 Phase 4');
  }

  /** Feed a verified, parsed webhook event. Safe to call twice with the same event. */
  async handleWebhook(event: WebhookEvent): Promise<WebhookOutcome> {
    if (event.type === 'post_call_audio') return 'ignored';
    const row = this.o.store.byConversation(event.data.conversation_id);
    if (!row) return 'unmatched';
    const read =
      event.type === 'post_call_transcription'
        ? readConversation(event.data)
        : readInitiationFailure(event.data.failure_reason);
    return (await this.conclude(row, read)) ? 'processed' : 'duplicate';
  }

  /** One pass over live calls: mark answered calls as talking, conclude finished ones. */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const row of this.o.store.live()) {
        try {
          const convo = await this.o.api.getConversation(row.conversationId!);
          if (convo.status === 'in-progress' && this.o.store.markTalking(row.callId)) {
            await this.doer(row.planId, 'working', `On the phone with ${this.venueOf(row).name}`);
          } else if (convo.status === 'done' || convo.status === 'failed') {
            await this.conclude(row, readConversation(convo));
          }
        } catch (err) {
          this.o.log.warn(
            { err: String(err), planId: row.planId, callId: row.callId },
            'caller poll failed',
          );
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private venueOf(row: CallRow): Venue {
    return row.attempt === 'backup' && row.request.backupVenue
      ? row.request.backupVenue
      : row.request.venue;
  }

  /** Real restaurants never ring unless listed: only the demo venue and allowlisted numbers. */
  private mayDial(venue: Venue): boolean {
    if (venue.phone === DEMO_VENUE_PHONE_PLACEHOLDER) return false;
    return venue.isDemo || this.o.config.CALLER_ALLOWED_NUMBERS.includes(venue.phone);
  }

  private variables(request: BookRequest, venue: Venue): Record<string, string | number> {
    const tz = this.o.config.CALLER_TIMEZONE;
    return {
      venue_name: venue.name,
      party_size: request.partySize,
      preferred_time: formatLocalTime(request.startAt, tz),
      window_start: formatLocalTime(addMinutes(request.startAt, -WINDOW_BEFORE_MIN), tz),
      window_end: formatLocalTime(addMinutes(request.startAt, WINDOW_AFTER_MIN), tz),
      booking_name: request.reservationName,
      callback_number: this.o.config.TWILIO_PHONE_NUMBER ?? 'this number',
      table_notes: request.tableNotes.length ? request.tableNotes.join('; ') : 'none',
    };
  }

  private async dial(row: CallRow, venue: Venue): Promise<void> {
    if (!this.mayDial(venue)) {
      this.o.log.warn(
        { planId: row.planId, callId: row.callId, venueId: venue.id },
        'caller refused: number not allowlisted',
      );
      await this.conclude(row, { kind: 'other', notes: 'not allowlisted' });
      return;
    }
    await this.doer(row.planId, 'started', `Dialing ${venue.name}`);
    try {
      const { conversationId, callSid } = await this.o.api.outboundCall({
        toNumber: venue.phone,
        dynamicVariables: this.variables(row.request, venue),
        ringTimeoutSecs: this.o.config.CALLER_RING_TIMEOUT_S,
      });
      this.o.store.setConversation(row.callId, conversationId);
      this.o.log.info(
        {
          planId: row.planId,
          callId: row.callId,
          conversationId,
          callSid,
          attempt: row.attempt,
          mark: 't_dial',
          at: this.now().toISOString(),
        },
        'caller dialing',
      );
    } catch (err) {
      this.o.log.error(
        { err: String(err), planId: row.planId, callId: row.callId },
        'caller dial failed',
      );
      await this.conclude(row, { kind: 'other', notes: 'dial failed' });
    }
  }

  /** Claim the call's result once, then either try the backup venue or report to the engine. */
  private async conclude(row: CallRow, read: CallRead): Promise<boolean> {
    if (!this.o.store.finish(row.callId, outcomeFor(read, row))) return false;
    const { request } = row;
    const venue = this.venueOf(row);

    if (triesBackup(read) && row.attempt === 'primary' && request.backupVenue) {
      const backup = request.backupVenue;
      await this.doer(row.planId, 'working', `${venue.name} can't take us. Calling ${backup.name}`);
      const backupRow = this.o.store.insert({
        callId: newId('call'),
        idempotencyKey: `${request.idempotencyKey}:backup`,
        planId: row.planId,
        bookingId: row.bookingId,
        attempt: 'backup',
        venueId: backup.id,
        request,
      });
      await this.dial(backupRow, backup);
      return true;
    }

    const outcome = outcomeFor(read, row);
    const at = this.now().toISOString();
    const tz = this.o.config.CALLER_TIMEZONE;
    const booked = read.kind === 'booked';
    const confirmed =
      booked && read.confirmedTime ? parseLocalTime(read.confirmedTime, request.startAt, tz) : null;
    const confirmedStartAt =
      confirmed && confirmed !== new Date(request.startAt).toISOString() ? confirmed : null;
    const startAt = confirmedStartAt ?? request.startAt;
    const name = (booked && read.nameOnReservation) || request.reservationName;

    const result: CallResult = {
      planId: row.planId,
      bookingId: row.bookingId,
      callId: row.callId,
      outcome,
      venueId: booked ? venue.id : null,
      confirmationCode: null,
      confirmedStartAt,
      depositRequested: read.kind === 'needs_human',
      summary: this.summary(outcome, row, formatLocalTime(startAt, tz), name),
      at,
    };

    if (booked) {
      await this.doer(row.planId, 'done', `Booked at ${venue.name}`);
      await this.o.bus.publish({
        type: 'booking_confirmed',
        planId: row.planId,
        at,
        bookingId: row.bookingId,
        venue: { venueId: venue.id, name: venue.name, cuisine: venue.cuisine },
        startAt,
        partySize: request.partySize,
        reservationName: name,
      });
      this.o.log.info(
        { planId: row.planId, callId: row.callId, outcome, mark: 't_booked', at },
        'caller booked',
      );
    } else if (outcome === 'needs_human') {
      await this.doer(row.planId, 'needs_human', `${venue.name} wants a card to hold the table`);
    } else {
      await this.doer(row.planId, 'failed', result.summary);
    }
    await this.o.onResult(result);
    return true;
  }

  private summary(outcome: CallOutcome, row: CallRow, time: string, name: string): string {
    const { request } = row;
    const venue = this.venueOf(row).name;
    const n = request.partySize;
    switch (outcome) {
      case 'booked':
        return `Table for ${n} at ${time} at ${venue} under ${name}.`;
      case 'booked_backup':
        return `${request.venue.name} couldn't take us. Table for ${n} at ${time} at ${venue} under ${name}.`;
      case 'declined':
        return row.attempt === 'backup'
          ? `Neither ${request.venue.name} nor ${venue} could seat ${n}.`
          : `${venue} could not seat ${n}.`;
      case 'no_answer':
        return row.attempt === 'backup'
          ? `Neither ${request.venue.name} nor ${venue} picked up.`
          : `${venue} did not pick up.`;
      case 'needs_human':
        return `${venue} wants a card to hold the table.`;
      default:
        return `The call to ${venue} didn't go through.`;
    }
  }

  private async doer(planId: string, state: DoerState, detail: string): Promise<void> {
    await this.o.bus.publish({
      type: 'doer_status',
      planId,
      at: this.now().toISOString(),
      doer: 'caller',
      state,
      detail: clip(detail),
    });
  }
}
