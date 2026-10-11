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

  it('reads an edit (our spectrum patch tags its id "<guid>:edit:<seq>")', () => {
    expect(normalize(msg({ type: 'text', text: 'vegan' }, { id: 'GUID-1:edit:42' }))).toMatchObject(
      { kind: 'edit', providerId: 'GUID-1:edit:42', editOf: 'GUID-1', text: 'vegan' },
    );
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

describe('location pins', () => {
  it('reads coordinates from an Apple CL.loc.vcf pin', async () => {
    const { parseCoordinates } = await import('./normalize.js');
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:;Current Location;;;',
      'item1.URL;type=pref:http://maps.apple.com/?ll=35.909700\\,-79.047500&q=35.909700\\,-79.047500',
      'item1.X-ABLabel:map url',
      'END:VCARD',
    ].join('\n');
    expect(parseCoordinates(vcard)).toEqual({ lat: 35.9097, lng: -79.0475 });
  });

  it('reads Google maps and geo: links, and rejects nonsense', async () => {
    const { parseCoordinates } = await import('./normalize.js');
    expect(parseCoordinates('https://www.google.com/maps/@35.9132,-79.0558,17z')).toEqual({
      lat: 35.9132,
      lng: -79.0558,
    });
    expect(parseCoordinates('geo:35.9,-79.05')).toEqual({ lat: 35.9, lng: -79.05 });
    expect(parseCoordinates('no coordinates here')).toBeNull();
    expect(parseCoordinates('?ll=200,-79')).toBeNull();
  });

  it('only treats vlocation / .loc.vcf attachments as pins', async () => {
    const { isLocationAttachment } = await import('./normalize.js');
    const read = async () => Buffer.from('');
    expect(
      isLocationAttachment({
        type: 'attachment',
        name: 'CL.loc.vcf',
        mimeType: 'text/vcard',
        read,
      }),
    ).toBe(true);
    expect(
      isLocationAttachment({ type: 'attachment', name: 'x', mimeType: 'text/x-vlocation', read }),
    ).toBe(true);
    expect(
      isLocationAttachment({ type: 'attachment', name: 'Ada.vcf', mimeType: 'text/vcard', read }),
    ).toBe(false);
    expect(isLocationAttachment({ type: 'text', text: 'hi' })).toBe(false);
  });
});
