/**
 * Id helpers shared by every module so ids and idempotency keys look the same everywhere.
 */
import { randomBytes, randomUUID } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** 128-bit random, url-safe. Used for live page tokens. */
export function newPageToken(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Deterministic idempotency key for an outbound action. Same inputs -> same key, so a retry
 * after a restart reuses the key and the adapter deduplicates.
 */
export function idempotencyKey(
  planId: string,
  action: string,
  ...parts: Array<string | number>
): string {
  return [planId, action, ...parts].join(':');
}
