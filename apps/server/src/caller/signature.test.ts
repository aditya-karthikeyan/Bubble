import { describe, expect, it } from 'vitest';
import { signPayload, verifySignature } from './signature.js';

const SECRET = 'wsec_test';
const BODY = '{"type":"post_call_transcription","data":{}}';
const NOW = 1_791_000_000_000;
const T = NOW / 1000;

describe('ElevenLabs webhook signature', () => {
  it('accepts a fresh, correctly signed body', () => {
    expect(verifySignature(BODY, signPayload(BODY, SECRET, T), SECRET, NOW)).toEqual({ ok: true });
  });

  it('rejects a tampered body, a wrong secret, and a missing header', () => {
    const header = signPayload(BODY, SECRET, T);
    expect(verifySignature(`${BODY} `, header, SECRET, NOW).ok).toBe(false);
    expect(verifySignature(BODY, header, 'other', NOW).ok).toBe(false);
    expect(verifySignature(BODY, undefined, SECRET, NOW).ok).toBe(false);
    expect(verifySignature(BODY, 'v0=abc', SECRET, NOW).ok).toBe(false);
  });

  it('rejects requests older than 30 minutes', () => {
    const old = signPayload(BODY, SECRET, T - 31 * 60);
    expect(verifySignature(BODY, old, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'timestamp outside tolerance',
    });
  });
});
