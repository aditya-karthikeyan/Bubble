/**
 * ElevenLabs conversation payloads (post-call webhook data and GET /conversations/:id share the
 * shape) and the deterministic read of what happened on the call. The agent fills the data
 * collection fields; code decides the outcome.
 */
import { z } from 'zod';

export const FAILURE_REASONS = [
  'no_answer',
  'voicemail',
  'full',
  'ivr_stuck',
  'deposit_required',
  'other',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

const Collected = z.record(z.string(), z.object({ value: z.unknown() }).passthrough());

export const Conversation = z
  .object({
    conversation_id: z.string(),
    status: z.string(),
    transcript: z
      .array(z.object({ role: z.string(), message: z.string().nullish() }).passthrough())
      .nullish(),
    metadata: z
      .object({
        call_duration_secs: z.number().nullish(),
        termination_reason: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    analysis: z.object({ data_collection_results: Collected.nullish() }).passthrough().nullish(),
  })
  .passthrough();
export type Conversation = z.infer<typeof Conversation>;

export const WebhookEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('post_call_transcription'), data: Conversation }),
  z.object({
    type: z.literal('call_initiation_failure'),
    data: z
      .object({ conversation_id: z.string(), failure_reason: z.string().nullish() })
      .passthrough(),
  }),
  z.object({ type: z.literal('post_call_audio'), data: z.unknown() }),
]);
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export type CallRead =
  | {
      kind: 'booked';
      confirmedTime: string | null;
      nameOnReservation: string | null;
      notes: string | null;
    }
  | { kind: 'needs_human'; notes: string | null }
  | { kind: Exclude<FailureReason, 'deposit_required'>; notes: string | null };

function value(collected: z.infer<typeof Collected> | null | undefined, key: string): unknown {
  return collected?.[key]?.value;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function bool(v: unknown): boolean {
  return v === true || v === 'true';
}

/** A call that never connected, before any data collection ran. */
export function readInitiationFailure(reason: string | null | undefined): CallRead {
  return {
    kind: /no.?answer|busy/i.test(reason ?? '') || !reason ? 'no_answer' : 'other',
    notes: reason ?? null,
  };
}

export function readConversation(c: Conversation): CallRead {
  const venueSpoke = (c.transcript ?? []).some((t) => t.role === 'user' && text(t.message));
  if (c.status === 'failed') {
    const read = readInitiationFailure(c.metadata?.termination_reason);
    return venueSpoke ? read : { kind: 'no_answer', notes: read.notes };
  }
  const collected = c.analysis?.data_collection_results;
  const notes = text(value(collected, 'notes'));
  if (bool(value(collected, 'booked'))) {
    return {
      kind: 'booked',
      confirmedTime: text(value(collected, 'confirmed_time')),
      nameOnReservation: text(value(collected, 'name_on_reservation')),
      notes,
    };
  }
  const reason = text(value(collected, 'failure_reason'));
  if (bool(value(collected, 'needs_human')) || reason === 'deposit_required') {
    return { kind: 'needs_human', notes };
  }
  if (reason && (FAILURE_REASONS as readonly string[]).includes(reason)) {
    return { kind: reason as Exclude<FailureReason, 'deposit_required'>, notes };
  }
  // Nobody spoke back: treat as unanswered so the backup venue gets a try.
  return { kind: venueSpoke ? 'other' : 'no_answer', notes };
}

/** Outcomes that send the caller to the backup venue. */
export function triesBackup(read: CallRead): boolean {
  return read.kind === 'no_answer' || read.kind === 'voicemail' || read.kind === 'full';
}
