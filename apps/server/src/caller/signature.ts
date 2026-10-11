/**
 * ElevenLabs webhook signatures, matching the SDK's constructEvent: the header is
 * "t=<unix seconds>,v0=<hex>", where hex = HMAC-SHA256(secret, "<t>.<raw body>"), and requests
 * older than 30 minutes are rejected.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_TOLERANCE_MS = 30 * 60 * 1000;

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

export function signPayload(rawBody: string, secret: string, timestampSecs: number): string {
  const hex = createHmac('sha256', secret).update(`${timestampSecs}.${rawBody}`).digest('hex');
  return `t=${timestampSecs},v0=${hex}`;
}

export function verifySignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  now: number = Date.now(),
): SignatureCheck {
  if (!header) return { ok: false, reason: 'missing signature header' };
  const parts = header.split(',');
  const t = parts.find((p) => p.startsWith('t='))?.slice(2);
  const v0 = parts.find((p) => p.startsWith('v0='));
  if (!t || !v0 || !/^\d+$/.test(t)) return { ok: false, reason: 'malformed signature header' };
  if (Number(t) * 1000 < now - SIGNATURE_TOLERANCE_MS) {
    return { ok: false, reason: 'timestamp outside tolerance' };
  }
  const expected = Buffer.from(signPayload(rawBody, secret, Number(t)).split(',')[1] ?? '');
  const given = Buffer.from(v0);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}
