/**
 * Which plan the organizer's watch page (/watch) shows. It polls the server's
 * /watch/<secret>/latest and switches to that plan's live feed only when it is worth putting on
 * the big screen: a plan started after the page was opened, or one that is mid-flight right now.
 * An old booked or closed plan never shows up; once a shown plan books it stays until a newer one
 * starts. Mirrors the server's fallback watch shell (apps/server/src/web/watch-route.ts).
 */

/** What GET /watch/:secret/latest returns. */
export interface WatchLatest {
  ok: boolean;
  planId: string | null;
  state: string | null;
  createdAt: string | null;
  pageUrl: string | null;
}

/** Plan states that are always worth showing, whenever the plan was created. */
export const LIVE_STATES: ReadonlySet<string> = new Set([
  'DETECTED',
  'GATHERING',
  'DELIBERATING',
  'DEADLOCK',
  'LOCKED',
  'BOOKING',
  'PAUSED',
]);

/** Slack on "created after the page opened", so a plan started just before still counts. */
export const OPEN_SLACK_MS = 60_000;

/** The page token at the end of a live page URL (<web>/p/<token>), or null. */
export function tokenFromPageUrl(pageUrl: string | null): string | null {
  if (!pageUrl) return null;
  const m = /\/p\/([^/?#]+)\/?(?:[?#].*)?$/.exec(pageUrl);
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * The token the page should show after this poll: the latest plan's when it qualifies, else
 * whatever is showing already (null keeps the empty gathering view).
 */
export function followToken(
  latest: WatchLatest | null,
  openedAtMs: number,
  current: string | null,
): string | null {
  const token = tokenFromPageUrl(latest?.pageUrl ?? null);
  if (!latest?.ok || !token) return current;
  if (token === current) return current;
  const created = latest.createdAt ? Date.parse(latest.createdAt) : NaN;
  const fresh = Number.isFinite(created) && created >= openedAtMs - OPEN_SLACK_MS;
  const live = latest.state !== null && LIVE_STATES.has(latest.state);
  return fresh || live ? token : current;
}
