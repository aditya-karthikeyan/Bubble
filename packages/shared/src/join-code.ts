/**
 * Crew join codes: "boys-4821". The organizer drops a link with the code in their group chat;
 * friends tap it, sign up if they need a bubble, and land in the crew. Nobody types a number.
 */
export function makeJoinCode(name: string, salt?: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 12)
      .replace(/-+$/g, '') || 'crew';
  const digits = salt
    ? String(Math.abs(hash(salt)) % 10_000).padStart(4, '0')
    : String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
  return `${slug}-${digits}`;
}

export function normalizeJoinCode(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}
