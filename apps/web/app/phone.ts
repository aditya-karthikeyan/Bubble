/**
 * Turn what people type ("(704) 555-1234", "704.555.1234", "+44 20 ...") into E.164, the format
 * /api/signup requires. Ten digits read as a US number. Null when it can't be a phone number.
 */
export function toE164(input: string): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, '');
  let e164: string;
  if (trimmed.startsWith('+')) e164 = `+${digits}`;
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith('1')) e164 = `+${digits}`;
  else return null;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

/** "+16282647754" -> "+1 (628) 264-7754"; other countries stay as given. */
export function prettyPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : e164;
}
