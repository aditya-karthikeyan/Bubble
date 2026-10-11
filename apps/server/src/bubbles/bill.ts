/**
 * After the meal: the person who paid tells their bubble, and the bubble splits the real bill.
 * Owner: P3. Pure helpers here; the flow lives in DbBubbleService (service.ts).
 *
 * "I covered this one, can you tell them to pay me" -> the most recent booked plan, the total
 * (asked for when the message has none), an even share per person who was in or represented,
 * rounded up to the cent so the payer is never short.
 */
import { METHOD_LABEL, payLink, type PayHandle, type PayMethod } from './payments.js';

/** Phrases that mean "I paid for the group, collect from them". */
export const PAID_BILL_PATTERNS: readonly RegExp[] = [
  /\bi (?:just )?covered (?:this one|it|dinner|lunch|brunch|breakfast|drinks|the bill|the check|the tab|everyone|us)\b/,
  /\bi (?:just )?paid\b(?!\s+(?:(?:you|him|her|them|\w+)\s+)?back\b)(?!\s+for myself\b)/,
  /\bi (?:got|grabbed|picked up|took care of) (?:the )?(?:bill|check|tab)\b/,
  /\bput it (?:all )?on my card\b/,
  /\bsplit (?:the|this|our) (?:bill|check|tab)\b/,
  /\b(?:can|could) you (?:let (?:them|everyone|the crew|the group) know|tell (?:them|everyone|the crew|the group)) to pay me\b/,
  /\b(?:they|everyone|y'?all) owes? me\b/,
];

/** "I covered dinner", "they owe me", ... Never "I don't want to split the bill". */
export function isPaidBillMessage(text: string): boolean {
  const t = text.toLowerCase().replace(/[’]/g, "'");
  if (/\b(?:don'?t|do not|never|won'?t|not)\b[^.?!]{0,20}\bsplit\b/.test(t)) return false;
  return PAID_BILL_PATTERNS.some((p) => p.test(t));
}

/** "never mind" while the bubble waits on an amount or a handle. */
export function isBillCancel(text: string): boolean {
  return /^\s*(?:never ?mind|nvm|cancel|forget it|stop|nah|no)\b/i.test(text);
}

const NUM = String.raw`(\d{1,5}(?:,\d{3})*(?:\.\d{1,2})?)`;

/**
 * The bill total in a message: "$84", "84 bucks", "it was 84.50". A bare number counts only
 * when `loose` is set (the reply to "How much was it?"), so "I paid for 4 of us" is not $4.
 */
export function parseBillAmount(text: string, opts: { loose?: boolean } = {}): number | null {
  const patterns = [
    new RegExp(String.raw`\$\s?${NUM}`),
    new RegExp(String.raw`${NUM}\s*(?:bucks|dollars|usd)\b`, 'i'),
    new RegExp(
      String.raw`\b(?:was|is|came to|total(?:ed)?|totaling|about|around)\s+(?:like\s+)?${NUM}\b(?!\s*(?:people|of us|ppl|min))`,
      'i',
    ),
  ];
  if (opts.loose) patterns.push(new RegExp(String.raw`(?:^|\s)${NUM}(?!\s*(?:people|of us|ppl))`));
  for (const p of patterns) {
    const m = p.exec(text);
    if (!m?.[1]) continue;
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0 && n < 100_000) return n;
  }
  return null;
}

/** Each person's share, rounded up to the cent so the payer is never short. */
export function shareOf(total: number, people: number): number {
  const cents = Math.round(total * 100);
  return Math.ceil(cents / Math.max(1, people)) / 100;
}

/** "$21" or "$21.13". */
export function usd(n: number): string {
  return `$${Number.isInteger(n) ? String(n) : n.toFixed(2)}`;
}

const METHOD_ORDER: readonly PayMethod[] = ['venmo', 'cashapp', 'paypal', 'zelle'];

/** The payer's best method: Venmo, then Cash App, PayPal, Zelle. */
export function preferredHandle(handles: readonly PayHandle[]): PayHandle | null {
  return (
    [...handles].sort(
      (a, b) => METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
    )[0] ?? null
  );
}

/** "Venmo" and the link with the amount filled in, or the handle when there is no link. */
export function payTarget(
  h: PayHandle,
  amount: number,
  note: string,
): { method: string; target: string } {
  return { method: METHOD_LABEL[h.method], target: payLink(h, amount, note) ?? h.id };
}
