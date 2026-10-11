import { describe, expect, it } from 'vitest';
import { isPaidBillMessage, parseBillAmount, preferredHandle, shareOf, usd } from './bill.js';

describe('bill helpers', () => {
  it('hears "I paid, collect from them" and nothing else', () => {
    for (const t of [
      'hey I covered this one, can you let them know to pay me',
      'i covered it',
      'I covered dinner',
      'I covered the bill',
      'I paid',
      'i paid for dinner, it was $84',
      'I got the bill',
      'just put it on my card',
      'can you split the bill',
      'can you tell them to pay me',
      'they owe me 60',
      'I’ll split the check? I paid',
    ])
      expect(isPaidBillMessage(t), t).toBe(true);
    for (const t of [
      "I don't want to split the bill",
      'I paid Ben back',
      'i paid for myself',
      'split it evenly',
      'dinner with the boys',
      'cancel',
    ])
      expect(isPaidBillMessage(t), t).toBe(false);
  });

  it('reads the total, and a bare number only as the answer to "how much?"', () => {
    expect(parseBillAmount('I covered dinner, $84')).toBe(84);
    expect(parseBillAmount('84 bucks')).toBe(84);
    expect(parseBillAmount('it was 84.50')).toBe(84.5);
    expect(parseBillAmount('came to $1,204.10 with tip')).toBe(1204.1);
    expect(parseBillAmount('I paid for 4 of us')).toBeNull();
    expect(parseBillAmount('I covered it')).toBeNull();
    expect(parseBillAmount('84', { loose: true })).toBe(84);
    expect(parseBillAmount('62.40 with tip', { loose: true })).toBe(62.4);
    expect(parseBillAmount('let me check', { loose: true })).toBeNull();
  });

  it('rounds each share up to the cent and picks Venmo first', () => {
    expect(shareOf(84.5, 4)).toBe(21.13);
    expect(shareOf(100, 3)).toBe(33.34);
    expect(shareOf(60, 2)).toBe(30);
    expect(usd(30)).toBe('$30');
    expect(usd(21.1)).toBe('$21.10');
    expect(
      preferredHandle([
        { method: 'zelle', id: '+19195550100' },
        { method: 'venmo', id: '@a' },
        { method: 'cashapp', id: '$a' },
      ]),
    ).toEqual({ method: 'venmo', id: '@a' });
    expect(preferredHandle([])).toBeNull();
  });
});
