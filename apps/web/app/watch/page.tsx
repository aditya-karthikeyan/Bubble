import type { Metadata } from 'next';
import { WatchPlan } from './watch-plan';

export const metadata: Metadata = {
  title: 'Live plan · Bubbleworks',
  description: 'Follows the newest plan, live.',
  robots: { index: false, follow: false },
};

/**
 * The organizer's watch page: /watch?s=<DEV_ROUTES_SECRET>&api=<server base URL>. The server's
 * GET /watch/<secret> redirects here. It opens on the live page's gathering view with no bubbles
 * and switches to each new plan's live feed in place, with no reload.
 */
export default async function WatchPage({
  searchParams,
}: {
  searchParams: Promise<{ s?: string | string[]; api?: string | string[] }>;
}) {
  const { s, api } = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
  return <WatchPlan secret={first(s)} api={first(api)} />;
}
