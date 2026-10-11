import { describe, expect, it } from 'vitest';
import {
  BACKUP_PHONE,
  DEMO_PHONE,
  conversation,
  primary,
  setup,
  unlisted,
} from './test-fixtures.js';

function transcription(id: string, collected: Record<string, unknown>) {
  return { type: 'post_call_transcription' as const, data: conversation(id, collected) };
}

describe('ElevenLabsCaller', () => {
  it('books the primary venue and reports once, with the confirmed time', async () => {
    const { api, caller, results, request, events } = setup();
    const handle = await caller.book(request());

    expect(handle.status).toBe('dialing');
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({
      toNumber: DEMO_PHONE,
      ringTimeoutSecs: 20,
      dynamicVariables: {
        venue_name: 'The Demo Table',
        party_size: 4,
        preferred_time: '7:00 PM',
        window_start: '6:30 PM',
        window_end: '8:00 PM',
        booking_name: 'Ava',
        callback_number: '+12297922464',
        table_notes: 'none',
        opener: 'Hi, this is an AI assistant calling for Ava. Do you take reservations?',
      },
    });

    const booked = transcription('conv_1', {
      booked: true,
      confirmed_time: '7:15 PM',
      name_on_reservation: 'Ava',
    });
    expect(await caller.handleWebhook(booked)).toBe('processed');
    expect(await caller.handleWebhook(booked)).toBe('duplicate');

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      callId: handle.callId,
      outcome: 'booked',
      venueId: 'venue_demo',
      confirmedStartAt: '2026-10-10T23:15:00.000Z',
      depositRequested: false,
      summary: 'Table for 4 at 7:15 PM at The Demo Table under Ava.',
    });

    // First and final events are the engine's; a clean primary booking adds none.
    expect(await events()).toEqual([]);
  });

  it('is idempotent on the booking key', async () => {
    const { api, caller, request } = setup();
    const a = await caller.book(request());
    const b = await caller.book(request());
    expect(b.callId).toBe(a.callId);
    expect(api.calls).toHaveLength(1);
  });

  it('dials the backup when the primary does not answer, and reports booked_backup', async () => {
    const { api, caller, results, request, events } = setup();
    await caller.book(request());
    await caller.handleWebhook({
      type: 'call_initiation_failure',
      data: { conversation_id: 'conv_1', failure_reason: 'no-answer' },
    });

    expect(results).toHaveLength(0);
    expect(api.calls.map((c) => c.toNumber)).toEqual([DEMO_PHONE, BACKUP_PHONE]);
    expect(await events()).toMatchObject([
      {
        type: 'doer_status',
        state: 'working',
        detail: "The Demo Table can't take us. Calling Backup Bistro",
      },
    ]);

    await caller.handleWebhook(
      transcription('conv_2', { booked: true, confirmed_time: '7:00 PM' }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      outcome: 'booked_backup',
      venueId: 'venue_backup',
      confirmedStartAt: null,
    });
    expect(results[0]!.summary).toBe(
      "The Demo Table couldn't take us. Table for 4 at 7:00 PM at Backup Bistro under Ava.",
    );
  });

  it('reports declined when both venues are full', async () => {
    const { caller, results, request } = setup();
    await caller.book(request());
    await caller.handleWebhook(transcription('conv_1', { booked: false, failure_reason: 'full' }));
    await caller.handleWebhook(transcription('conv_2', { booked: false, failure_reason: 'full' }));
    expect(results.map((r) => r.outcome)).toEqual(['declined']);
    expect(results[0]!.summary).toBe('Neither The Demo Table nor Backup Bistro could seat 4.');
  });

  it('stops at a deposit request and asks for a human, without trying the backup', async () => {
    const { api, caller, results, request } = setup();
    await caller.book(request());
    await caller.handleWebhook(
      transcription('conv_1', {
        booked: false,
        needs_human: true,
        failure_reason: 'deposit_required',
      }),
    );
    expect(api.calls).toHaveLength(1);
    expect(results[0]).toMatchObject({
      outcome: 'needs_human',
      depositRequested: true,
      venueId: null,
    });
  });

  it('refuses numbers that are neither the demo venue nor allowlisted', async () => {
    const { api, caller, results, request } = setup();
    await caller.book(request({ venue: unlisted, backupVenue: null }));
    expect(api.calls).toHaveLength(0);
    expect(results[0]).toMatchObject({ outcome: 'failed', venueId: null });
  });

  it('reports a failed dial without calling the backup', async () => {
    const { api, caller, results, request } = setup();
    api.failNextDial = true;
    await caller.book(request());
    expect(api.calls).toHaveLength(0);
    expect(results.map((r) => r.outcome)).toEqual(['failed']);
  });

  it('polls as a fallback: talking when answered, concluded when done, webhook then a no-op', async () => {
    const { api, caller, results, request, events } = setup();
    await caller.book(request());

    api.convos.set('conv_1', { conversation_id: 'conv_1', status: 'in-progress' });
    await caller.pollOnce();
    await caller.pollOnce();
    expect(
      (await events()).filter((e) => e.type === 'doer_status' && e.state === 'working'),
    ).toHaveLength(1);

    const done = conversation('conv_1', { booked: true, confirmed_time: '7:30 PM' });
    api.convos.set('conv_1', done);
    await caller.pollOnce();
    expect(results.map((r) => r.outcome)).toEqual(['booked']);
    expect(await caller.handleWebhook({ type: 'post_call_transcription', data: done })).toBe(
      'duplicate',
    );
  });

  it('skips the disclosure only when CALLER_DISCLOSE is off', async () => {
    const { api, caller, request } = setup({ disclose: false });
    await caller.book(request());
    expect(api.calls[0]!.dynamicVariables['opener']).toBe(
      'Hey! Quick question, do you guys take reservations?',
    );
  });

  it('modifies, cancels, and holds through the same agent with a call purpose', async () => {
    const { api, caller, results, plan } = setup();
    await caller.modify({
      planId: plan.id,
      bookingId: 'booking_1',
      venue: primary,
      partySize: 5,
      startAt: '2026-10-10T23:00:00.000Z',
      reservationName: 'Ava',
      idempotencyKey: 'modify:1',
    });
    await caller.cancel({
      planId: plan.id,
      bookingId: 'booking_1',
      venue: primary,
      reservationName: 'Ava',
      idempotencyKey: 'cancel:1',
    });
    await caller.holdTable({
      planId: plan.id,
      bookingId: 'booking_1',
      venue: primary,
      partySize: 4,
      startAt: '2026-10-10T23:00:00.000Z',
      holdMinutes: 15,
      idempotencyKey: 'hold:1',
    });
    expect(api.calls.map((c) => c.dynamicVariables['call_purpose'])).toEqual([
      'modify',
      'cancel',
      'hold',
    ]);
    expect(api.calls[0]!.dynamicVariables).toMatchObject({ party_size: 5, booking_name: 'Ava' });
    expect(api.calls[2]!.dynamicVariables).toMatchObject({
      hold_minutes: 15,
      preferred_time: '7:00 PM',
    });
    expect(api.calls[2]!.dynamicVariables['opener']).toBe(
      'Hi, this is an AI assistant calling for our group, about the 7:00 PM table.',
    );

    for (const id of ['conv_1', 'conv_2', 'conv_3']) {
      await caller.handleWebhook(transcription(id, { booked: true }));
    }
    expect(results.map((r) => r.outcome)).toEqual(['modified', 'cancelled', 'booked']);
    expect(results[1]!.venueId).toBeNull();
    expect(results[2]!.summary).toBe(
      'The Demo Table is holding the 7:00 PM table for 15 more minutes.',
    );
  });

  it('never reports failed for a modify, cancel, or hold, so a booked plan is not failed', async () => {
    const { caller, results, plan } = setup();
    await caller.holdTable({
      planId: plan.id,
      bookingId: 'booking_1',
      venue: primary,
      partySize: 4,
      startAt: '2026-10-10T23:00:00.000Z',
      holdMinutes: 10,
      idempotencyKey: 'hold:2',
    });
    await caller.handleWebhook(transcription('conv_1', { booked: false, failure_reason: 'other' }));
    await caller.cancel({
      planId: plan.id,
      bookingId: 'booking_1',
      venue: unlisted,
      reservationName: 'Ava',
      idempotencyKey: 'cancel:2',
    });
    expect(results.map((r) => r.outcome)).toEqual(['declined', 'declined']);
  });

  it('ignores unknown conversations and audio events', async () => {
    const { caller } = setup();
    expect(await caller.handleWebhook(transcription('conv_nope', { booked: true }))).toBe(
      'unmatched',
    );
    expect(await caller.handleWebhook({ type: 'post_call_audio', data: {} })).toBe('ignored');
  });

  it('never puts a phone number on the page', async () => {
    const { caller, request, events } = setup();
    await caller.book(request());
    await caller.handleWebhook({
      type: 'call_initiation_failure',
      data: { conversation_id: 'conv_1', failure_reason: 'busy' },
    });
    await caller.handleWebhook(transcription('conv_2', { booked: true }));
    const page = JSON.stringify(await events());
    expect(page).not.toContain(DEMO_PHONE);
    expect(page).not.toContain(BACKUP_PHONE);
    expect(page).not.toContain('5550001111');
  });
});
