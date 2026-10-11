/**
 * Payment handles: how friends pay someone back. Owner: P3.
 *
 * Stored as payment_handle facts, one per method, value "<method>:<id>":
 * venmo:@name, cashapp:$name, paypal:name (or an email), zelle:+19195550100 (or an email).
 * A legacy venmo_handle fact ("@name") still counts as Venmo.
 */

export type PayMethod = 'venmo' | 'cashapp' | 'paypal' | 'zelle';

export interface PayHandle {
  method: PayMethod;
  /** "@name" for Venmo, "$name" for Cash App, a paypal.me name or email, a phone or email. */
  id: string;
}

export const METHOD_LABEL: Record<PayMethod, string> = {
  venmo: 'Venmo',
  cashapp: 'Cash App',
  paypal: 'PayPal',
  zelle: 'Zelle',
};

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const PHONE = /(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}\b/;

/**
 * Every handle in a message. A bare phone or email counts as Zelle only when `bareContact` is
 * set (the onboarding payment question) or the message says Zelle; with "paypal" an email is
 * PayPal. "$20" is a budget, never a cashtag (cashtags start with a letter).
 */
export function parsePaymentHandles(
  text: string,
  opts: { bareContact?: boolean } = {},
): PayHandle[] {
  const out: PayHandle[] = [];
  const add = (method: PayMethod, id: string) => {
    if (!out.some((h) => h.method === method)) out.push({ method, id });
  };
  const t = text.trim();
  const lower = t.toLowerCase();

  const paypalMe = /paypal\.me\/([A-Za-z0-9_.-]{1,40})/i.exec(t);
  if (paypalMe) add('paypal', paypalMe[1]!);
  // Strip emails and paypal.me links so their "@" or "." never reads as a Venmo handle.
  const rest = t.replace(/paypal\.me\/\S+/gi, ' ').replace(new RegExp(EMAIL.source, 'g'), ' ');

  const cashtag = /(?:^|[\s(,:])\$([A-Za-z][A-Za-z0-9_]{0,19})\b/.exec(rest);
  if (cashtag) add('cashapp', `$${cashtag[1]}`);
  const at = /(?:^|[\s(,:])@([A-Za-z0-9_-]{3,30})\b/.exec(rest);
  if (at) add('venmo', `@${at[1]}`);
  if (!at) {
    const named = /\bvenmo(?:\s+is|\s*:)?\s+@?([A-Za-z0-9_-]{3,30})\b/i.exec(rest);
    if (named && !/^(is|me|handle|account)$/i.test(named[1]!)) add('venmo', `@${named[1]}`);
  }

  const saysZelle = /\bzelle\b/.test(lower);
  const email = EMAIL.exec(t)?.[0];
  if (email) {
    if (/\bpaypal\b/.test(lower) && !saysZelle) add('paypal', email.toLowerCase());
    else if (opts.bareContact || saysZelle) add('zelle', email.toLowerCase());
  }
  const phone = PHONE.exec(rest)?.[0];
  if (phone && (opts.bareContact || saysZelle)) {
    const digits = phone.replace(/\D/g, '');
    const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;
    if (digits.length === 10 || (digits.length === 11 && digits.startsWith('1')))
      add('zelle', e164);
  }
  return out;
}

export function encodeHandle(h: PayHandle): string {
  return `${h.method}:${h.id}`;
}

export function decodeHandle(value: string): PayHandle | null {
  const i = value.indexOf(':');
  const method = value.slice(0, i) as PayMethod;
  if (i <= 0 || !(method in METHOD_LABEL)) return null;
  return { method, id: value.slice(i + 1) };
}

/** A link with the amount filled in, or null (Zelle has no public pay link). */
export function payLink(h: PayHandle, amount: number, note: string): string | null {
  const id = h.id.replace(/^[@$]/, '');
  switch (h.method) {
    case 'venmo':
      return `https://venmo.com/?txn=pay&recipients=${encodeURIComponent(id)}&amount=${amount}&note=${encodeURIComponent(note)}`;
    case 'cashapp':
      return `https://cash.app/$${encodeURIComponent(id)}/${amount}`;
    case 'paypal':
      return EMAIL.test(id) ? null : `https://paypal.me/${encodeURIComponent(id)}/${amount}USD`;
    case 'zelle':
      return null;
  }
}

/** One line per method: "Venmo: <link>", or "Zelle Ben at +1919… · $30" when there is no link. */
export function payLine(h: PayHandle, payerName: string, amount: number, note: string): string {
  const link = payLink(h, amount, note);
  return link
    ? `${METHOD_LABEL[h.method]}: ${link}`
    : `${METHOD_LABEL[h.method]} ${payerName} at ${h.id} · $${amount}`;
}

export function describeHandle(h: PayHandle): string {
  return `${METHOD_LABEL[h.method]} ${h.id}`;
}
