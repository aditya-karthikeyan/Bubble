/**
 * Browser stand-in for node:crypto, which @bubbleworks/shared imports for id generation. The
 * page only reads events and never mints ids, so these exist to satisfy the bundler.
 */
export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

export function randomBytes(): never {
  throw new Error('randomBytes is server-only');
}
