/**
 * FakeCaller: every call "connects" and reports booked after a delay (3 seconds by default)
 * through the result sink, the same path the real ElevenLabs post-call webhook uses.
 * Scripted outcomes let simulations stage no-answer, declined, and deposit cases.
 */
import type { BookRequest, CallHandle, CallOutcome, CallResult, CallerPort } from '../ports.js';
import type { IsoDateTime, Venue } from '../types.js';

export type CallResultSink = (result: CallResult) => Promise<void>;

export interface FakeCallerOptions {
  /** Delay before the result is delivered. Default 3000 ms. */
  delayMs?: number;
  /** Outcome for the next calls, consumed in order. Default: booked. */
  scriptedOutcomes?: CallOutcome[];
  log?: (line: string) => void;
}

type RecordedCall =
  | { kind: 'book'; request: BookRequest; callId: string }
  | {
      kind: 'modify';
      bookingId: string;
      venue: Venue;
      partySize: number;
      startAt: IsoDateTime;
      callId: string;
    }
  | { kind: 'cancel'; bookingId: string; venue: Venue; callId: string }
  | { kind: 'hold'; bookingId: string; venue: Venue; holdMinutes: number; callId: string };

export class FakeCaller implements CallerPort {
  readonly calls: RecordedCall[] = [];
  private readonly seenKeys = new Map<string, CallHandle>();
  private readonly pending = new Set<ReturnType<typeof setTimeout>>();
  private readonly scripted: CallOutcome[];
  private readonly delayMs: number;
  private readonly log: (line: string) => void;
  private counter = 0;

  constructor(
    private readonly sink: CallResultSink,
    options: FakeCallerOptions = {},
  ) {
    this.delayMs = options.delayMs ?? 3000;
    this.scripted = [...(options.scriptedOutcomes ?? [])];
    this.log = options.log ?? (() => undefined);
  }

  async book(request: BookRequest): Promise<CallHandle> {
    return this.once(request.idempotencyKey, () => {
      const callId = this.nextId();
      this.calls.push({ kind: 'book', request, callId });
      this.log(
        `FakeCaller dialing ${request.venue.name} for ${request.partySize} at ${request.startAt}`,
      );
      const outcome = this.scripted.shift() ?? 'booked';
      const venueId =
        outcome === 'booked_backup'
          ? (request.backupVenue?.id ?? null)
          : outcome === 'booked'
            ? request.venue.id
            : null;
      this.deliver({
        planId: request.planId,
        bookingId: request.bookingId,
        callId,
        outcome,
        venueId,
        confirmationCode: venueId ? `FAKE-${callId.toUpperCase()}` : null,
        confirmedStartAt: null,
        depositRequested: outcome === 'needs_human',
        summary: this.summary(outcome, request),
        at: '',
      });
      return { callId, status: 'dialing' };
    });
  }

  async modify(input: Parameters<CallerPort['modify']>[0]): Promise<CallHandle> {
    return this.once(input.idempotencyKey, () => {
      const callId = this.nextId();
      this.calls.push({
        kind: 'modify',
        bookingId: input.bookingId,
        venue: input.venue,
        partySize: input.partySize,
        startAt: input.startAt,
        callId,
      });
      this.deliver({
        planId: input.planId,
        bookingId: input.bookingId,
        callId,
        outcome: this.scripted.shift() ?? 'modified',
        venueId: input.venue.id,
        confirmationCode: null,
        confirmedStartAt: input.startAt,
        depositRequested: false,
        summary: `Updated to ${input.partySize} at ${input.venue.name}.`,
        at: '',
      });
      return { callId, status: 'dialing' };
    });
  }

  async cancel(input: Parameters<CallerPort['cancel']>[0]): Promise<CallHandle> {
    return this.once(input.idempotencyKey, () => {
      const callId = this.nextId();
      this.calls.push({ kind: 'cancel', bookingId: input.bookingId, venue: input.venue, callId });
      this.deliver({
        planId: input.planId,
        bookingId: input.bookingId,
        callId,
        outcome: this.scripted.shift() ?? 'cancelled',
        venueId: input.venue.id,
        confirmationCode: null,
        confirmedStartAt: null,
        depositRequested: false,
        summary: `Cancelled at ${input.venue.name}.`,
        at: '',
      });
      return { callId, status: 'dialing' };
    });
  }

  async holdTable(input: Parameters<CallerPort['holdTable']>[0]): Promise<CallHandle> {
    return this.once(input.idempotencyKey, () => {
      const callId = this.nextId();
      this.calls.push({
        kind: 'hold',
        bookingId: input.bookingId,
        venue: input.venue,
        holdMinutes: input.holdMinutes,
        callId,
      });
      this.deliver({
        planId: input.planId,
        bookingId: input.bookingId,
        callId,
        outcome: this.scripted.shift() ?? 'booked',
        venueId: input.venue.id,
        confirmationCode: `HOLD-${callId.toUpperCase()}`,
        confirmedStartAt: input.startAt,
        depositRequested: false,
        summary: `Held ${input.partySize} at ${input.venue.name} for ${input.holdMinutes} min.`,
        at: '',
      });
      return { callId, status: 'dialing' };
    });
  }

  /** Cancel pending deliveries, for test teardown. */
  dispose(): void {
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
  }

  private once(key: string, run: () => CallHandle): CallHandle {
    const seen = this.seenKeys.get(key);
    if (seen) return seen;
    const handle = run();
    this.seenKeys.set(key, handle);
    return handle;
  }

  private deliver(result: CallResult): void {
    const t = setTimeout(() => {
      this.pending.delete(t);
      void this.sink({ ...result, at: new Date().toISOString() });
    }, this.delayMs);
    this.pending.add(t);
  }

  private summary(outcome: CallOutcome, r: BookRequest): string {
    switch (outcome) {
      case 'booked':
        return `Table for ${r.partySize} at ${r.venue.name} under ${r.reservationName}.`;
      case 'booked_backup':
        return `${r.venue.name} was full. Table for ${r.partySize} at ${r.backupVenue?.name ?? 'the backup'} under ${r.reservationName}.`;
      case 'declined':
        return `${r.venue.name} could not seat ${r.partySize}.`;
      case 'no_answer':
        return `${r.venue.name} did not pick up.`;
      case 'needs_human':
        return `${r.venue.name} asked for a card to hold the table.`;
      default:
        return `Call to ${r.venue.name} ended: ${outcome}.`;
    }
  }

  private nextId(): string {
    this.counter += 1;
    return `call_${this.counter}`;
  }
}
