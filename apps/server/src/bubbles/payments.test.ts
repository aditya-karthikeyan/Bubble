import { describe, expect, it } from 'vitest';
import { decodeHandle, encodeHandle, parsePaymentHandles, payLine } from './payments.js';

describe('payment handles', () => {
  const read = (t: string, bareContact = false) =>
    parsePaymentHandles(t, { bareContact }).map(encodeHandle);

  it('detects the method from the format', () => {
    expect(read('@pranav-s')).toEqual(['venmo:@pranav-s']);
    expect(read('$pranavs')).toEqual(['cashapp:$pranavs']);
    expect(read('paypal.me/pranavs')).toEqual(['paypal:pranavs']);
    expect(read('919-555-0100', true)).toEqual(['zelle:+19195550100']);
    expect(read('pranav@gmail.com', true)).toEqual(['zelle:pranav@gmail.com']);
    expect(read('venmo @pranav-s, cash app $pranavs, zelle 9195550100')).toEqual([
      'cashapp:$pranavs',
      'venmo:@pranav-s',
      'zelle:+19195550100',
    ]);
    expect(read('my venmo is pranav-s')).toEqual(['venmo:@pranav-s']);
    expect(read('paypal pranav@gmail.com')).toEqual(['paypal:pranav@gmail.com']);
  });

  it('never reads a budget, an email, or a bare number in chat as a handle', () => {
    expect(read('$20')).toEqual([]);
    expect(read('email me at pranav@gmail.com')).toEqual([]);
    expect(read('call 919-555-0100')).toEqual([]);
  });

  it('builds links with the amount filled in, and Zelle as text', () => {
    const note = 'Alpha Pie Oct 10';
    const line = (v: string) => payLine(decodeHandle(v)!, 'Ben', 30, note);
    expect(line('venmo:@ben')).toBe(
      'Venmo: https://venmo.com/?txn=pay&recipients=ben&amount=30&note=Alpha%20Pie%20Oct%2010',
    );
    expect(line('cashapp:$benb')).toBe('Cash App: https://cash.app/$benb/30');
    expect(line('paypal:benb')).toBe('PayPal: https://paypal.me/benb/30USD');
    expect(line('zelle:+19195550100')).toBe('Zelle Ben at +19195550100 · $30');
    expect(line('paypal:ben@x.com')).toBe('PayPal Ben at ben@x.com · $30');
  });
});
