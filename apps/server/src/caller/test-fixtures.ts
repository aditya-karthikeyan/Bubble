import type { BookRequest, CallResult, PlanEvent, Venue } from '@bubbleworks/shared';
import { INTENT, testRuntime } from '../test-helpers.js';
import { demoVenue } from '../venues/demo-venue.js';
import { ElevenLabsCaller } from './adapter.js';
import type { Conversation } from './conversation.js';
import type { ElevenLabsApi, OutboundCallInput } from './elevenlabs.js';
import { CallerStore } from './store.js';

export const DEMO_PHONE = '+15550001111';
export const BACKUP_PHONE = '+15550002222';

export const primary: Venue = demoVenue(DEMO_PHONE);
export const backup: Venue = {
  ...demoVenue(BACKUP_PHONE),
  id: 'venue_backup',
  name: 'Backup Bistro',
  isDemo: false,
};
export const unlisted: Venue = {
  ...backup,
  id: 'venue_real',
  name: 'Real Place',
  phone: '+19195550123',
};

export class FakeApi implements ElevenLabsApi {
  readonly calls: OutboundCallInput[] = [];
  readonly convos = new Map<string, Conversation>();
  failNextDial = false;

  async outboundCall(input: OutboundCallInput) {
    if (this.failNextDial) {
      this.failNextDial = false;
      throw new Error('ElevenLabs POST /twilio/outbound-call -> 400');
    }
    this.calls.push(input);
    return { conversationId: `conv_${this.calls.length}`, callSid: `CA${this.calls.length}` };
  }

  async getConversation(id: string): Promise<Conversation> {
    return this.convos.get(id) ?? { conversation_id: id, status: 'initiated' };
  }
}

/** A finished conversation with the given data collection values. */
export function conversation(
  id: string,
  collected: Record<string, unknown>,
  opts: { status?: string; venueSpoke?: boolean } = {},
): Conversation {
  return {
    conversation_id: id,
    status: opts.status ?? 'done',
    transcript: opts.venueSpoke === false ? [] : [{ role: 'user', message: 'Hello, Demo Table.' }],
    metadata: { call_duration_secs: 42, termination_reason: 'end_call tool' },
    analysis: {
      data_collection_results: Object.fromEntries(
        Object.entries(collected).map(([k, value]) => [k, { data_collection_id: k, value }]),
      ),
    },
  };
}

export function setup(overrides: { allowed?: string[]; pollMs?: number; disclose?: boolean } = {}) {
  const rt = testRuntime();
  const plan = rt.plans.create({
    groupId: 'group_demo',
    chatId: 'crew:group_demo',
    intent: INTENT,
    createdByUserId: 'user_ava',
    demoMode: true,
  });
  const api = new FakeApi();
  const results: CallResult[] = [];
  const caller = new ElevenLabsCaller({
    api,
    store: new CallerStore(rt.handle.sqlite),
    bus: rt.bus,
    onResult: async (r) => {
      results.push(r);
    },
    config: {
      CALLER_ALLOWED_NUMBERS: overrides.allowed ?? [BACKUP_PHONE],
      CALLER_RING_TIMEOUT_S: 20,
      CALLER_TIMEZONE: 'America/New_York',
      CALLER_POLL_MS: overrides.pollMs ?? 0,
      TWILIO_PHONE_NUMBER: '+12297922464',
      CALLER_DISCLOSE: overrides.disclose ?? true,
    },
    log: rt.log,
  });
  const request = (over: Partial<BookRequest> = {}): BookRequest => ({
    planId: plan.id,
    bookingId: 'booking_1',
    venue: primary,
    backupVenue: backup,
    partySize: 4,
    // 7:00 PM EDT
    startAt: '2026-10-10T23:00:00.000Z',
    reservationName: 'Ava',
    tableNotes: [],
    idempotencyKey: `${plan.id}:book:1`,
    ...over,
  });
  const events = async (): Promise<PlanEvent[]> => rt.bus.replay(plan.id);
  return { rt, plan, api, caller, results, request, events };
}
