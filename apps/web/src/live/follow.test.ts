import { describe, expect, it } from 'vitest';
import { followToken, tokenFromPageUrl, type WatchLatest } from './follow';

const OPENED = Date.parse('2026-10-11T19:00:00.000Z');

function latest(token: string | null, state: string | null, createdAt: string | null): WatchLatest {
  return {
    ok: true,
    planId: token ? `plan_${token}` : null,
    state,
    createdAt,
    pageUrl: token ? `https://web.test/p/${token}` : null,
  };
}

describe('tokenFromPageUrl', () => {
  it('reads the token off a live page URL', () => {
    expect(tokenFromPageUrl('https://web.test/p/abc123')).toBe('abc123');
    expect(tokenFromPageUrl('https://web.test/p/abc123/?x=1')).toBe('abc123');
    expect(tokenFromPageUrl('https://web.test/t/abc123')).toBeNull();
    expect(tokenFromPageUrl(null)).toBeNull();
  });
});

describe('followToken', () => {
  it('stays empty when there is no plan at all', () => {
    expect(followToken(latest(null, null, null), OPENED, null)).toBeNull();
    expect(followToken(null, OPENED, null)).toBeNull();
  });

  it('never shows a plan that was already booked or closed when the page opened', () => {
    expect(followToken(latest('old', 'BOOKED', '2026-10-11T17:00:00.000Z'), OPENED, null)).toBe(
      null,
    );
    expect(followToken(latest('old', 'CLOSED', '2026-10-11T17:00:00.000Z'), OPENED, null)).toBe(
      null,
    );
  });

  it('shows a plan created after the page opened, with a minute of slack', () => {
    expect(followToken(latest('new', 'BOOKED', '2026-10-11T19:05:00.000Z'), OPENED, null)).toBe(
      'new',
    );
    expect(followToken(latest('new', 'CLOSED', '2026-10-11T18:59:30.000Z'), OPENED, null)).toBe(
      'new',
    );
  });

  it('shows any plan that is mid-flight, however old', () => {
    for (const state of [
      'DETECTED',
      'GATHERING',
      'DELIBERATING',
      'DEADLOCK',
      'LOCKED',
      'BOOKING',
      'PAUSED',
    ]) {
      expect(followToken(latest('mid', state, '2026-10-11T12:00:00.000Z'), OPENED, null)).toBe(
        'mid',
      );
    }
  });

  it('keeps a shown plan once it books, and switches when a newer one starts', () => {
    const booked = latest('a', 'BOOKED', '2026-10-11T12:00:00.000Z');
    expect(followToken(booked, OPENED, 'a')).toBe('a');
    // An older, finished plan resurfacing does not replace what is showing.
    expect(followToken(latest('z', 'CLOSED', '2026-10-11T10:00:00.000Z'), OPENED, 'a')).toBe('a');
    expect(followToken(latest('b', 'DETECTED', '2026-10-11T19:30:00.000Z'), OPENED, 'a')).toBe('b');
  });

  it('ignores an error reply', () => {
    expect(followToken({ ...latest('x', 'GATHERING', null), ok: false }, OPENED, 'a')).toBe('a');
  });
});
