/** Public URLs the web app needs, from env, with local fallbacks. */
export const SERVER_URL = (
  process.env['NEXT_PUBLIC_SOCKET_URL'] ?? 'http://localhost:3001'
).replace(/\/$/, '');

export function siteUrl(): string {
  const explicit = process.env['NEXT_PUBLIC_SITE_URL'];
  if (explicit) return explicit.replace(/\/$/, '');
  const vercel = process.env['VERCEL_PROJECT_PRODUCTION_URL'];
  return vercel ? `https://${vercel}` : 'http://localhost:3000';
}
