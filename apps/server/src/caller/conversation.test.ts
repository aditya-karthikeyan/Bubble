import { describe, expect, it } from 'vitest';
import { readConversation, readInitiationFailure, triesBackup } from './conversation.js';
import { conversation } from './test-fixtures.js';

describe('reading a finished call', () => {
  it('reads a booking with its confirmed time and name', () => {
    const read = readConversation(
      conversation('c1', {
        booked: true,
        confirmed_time: '7:15 PM',
        name_on_reservation: 'Ava',
        failure_reason: '',
      }),
    );
    expect(read).toEqual({
      kind: 'booked',
      confirmedTime: '7:15 PM',
      nameOnReservation: 'Ava',
      notes: null,
    });
  });

  it('treats a deposit request as needing a human, even without the flag', () => {
    expect(
      readConversation(conversation('c1', { booked: false, failure_reason: 'deposit_required' }))
        .kind,
    ).toBe('needs_human');
    expect(readConversation(conversation('c1', { booked: false, needs_human: true })).kind).toBe(
      'needs_human',
    );
  });

  it('maps failure reasons, and sends only unanswered, voicemail, and full to the backup', () => {
    for (const [reason, backup] of [
      ['no_answer', true],
      ['voicemail', true],
      ['full', true],
      ['ivr_stuck', false],
      ['other', false],
    ] as const) {
      const read = readConversation(conversation('c1', { booked: false, failure_reason: reason }));
      expect(read.kind).toBe(reason);
      expect(triesBackup(read)).toBe(backup);
    }
  });

  it('reads silence as no answer and a failed call as not connected', () => {
    expect(readConversation(conversation('c1', {}, { venueSpoke: false })).kind).toBe('no_answer');
    expect(readConversation(conversation('c1', {})).kind).toBe('other');
    expect(
      readConversation(conversation('c1', {}, { status: 'failed', venueSpoke: false })).kind,
    ).toBe('no_answer');
    expect(readConversation(conversation('c1', {}, { status: 'failed' })).kind).toBe('other');
    expect(readInitiationFailure('busy').kind).toBe('no_answer');
    expect(readInitiationFailure('unknown').kind).toBe('other');
  });
});
