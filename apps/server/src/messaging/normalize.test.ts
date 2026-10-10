import { describe, expect, it } from 'vitest';
import { normalize, pollMessageIdFromVoteId } from './normalize.js';

const timestamp = new Date('2026-10-10T22:00:00.000Z');
const space = { id: 'any;-;+19806220567' };

function msg(content: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { id: 'spc-msg-1', direction: 'inbound', timestamp, space, content, ...extra };
}

describe('normalize', () => {
  it('reads text and the phone behind the DM chat id', () => {
    expect(normalize(msg({ type: 'text', text: 'dinner today?' }))).toEqual({
      kind: 'text',
      providerId: 'spc-msg-1',
      phone: '+19806220567',
      text: 'dinner today?',
      at: '2026-10-10T22:00:00.000Z',
    });
  });

  it('unwraps a threaded reply', () => {
    const event = normalize(
      msg({ type: 'reply', target: { id: 'spc-msg-0' }, content: { type: 'text', text: 'in' } }),
    );
    expect(event).toMatchObject({ kind: 'text', text: 'in', replyToMessageId: 'spc-msg-0' });
  });

  it('reads a tapback', () => {
    expect(
      normalize(msg({ type: 'reaction', emoji: '👍', target: { id: 'spc-msg-9' } })),
    ).toMatchObject({
      kind: 'reaction',
      emoji: '👍',
      targetMessageId: 'spc-msg-9',
      removed: false,
    });
  });

  it('reads a poll vote and the poll it belongs to', () => {
    const event = normalize(
      msg(
        {
          type: 'poll_option',
          option: { title: 'Thai' },
          selected: true,
          poll: { type: 'poll', title: 'Poll', options: [] },
        },
        { id: 'spc-msg-f62:+19806220567:opt-1:selected:1760133600000' },
      ),
    );
    expect(event).toMatchObject({
      kind: 'poll_vote',
      pollMessageId: 'spc-msg-f62',
      optionLabel: 'Thai',
      selected: true,
    });
  });

  it('drops outbound echoes, read receipts, blank text, and malformed payloads', () => {
    expect(normalize(msg({ type: 'text', text: 'hi' }, { direction: 'outbound' }))).toBeNull();
    expect(normalize(msg({ type: 'read', target: { id: 'x' } }))).toBeNull();
    expect(normalize(msg({ type: 'text', text: '   ' }))).toBeNull();
    expect(normalize({ id: 'x' })).toBeNull();
    expect(normalize(null)).toBeNull();
  });

  it('takes the poll id from the head of a vote id', () => {
    expect(pollMessageIdFromVoteId('abc:def')).toBe('abc');
    expect(pollMessageIdFromVoteId('')).toBeNull();
  });
});
