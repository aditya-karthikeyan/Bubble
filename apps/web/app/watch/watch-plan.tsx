'use client';

import { useEffect, useState } from 'react';
import { followToken, type WatchLatest } from '../../src/live/follow';
import { LivePlan } from '../../src/live/live-plan';
import { SERVER_URL } from '../site';

const POLL_MS = 2500;

/** An http(s) base URL without a trailing slash, else the build-time server URL. */
function serverBase(api: string | null): string {
  if (api && /^https?:\/\//i.test(api)) return api.replace(/\/+$/, '');
  return SERVER_URL;
}

/**
 * Polls the server's /watch/<secret>/latest and points the live page at the plan worth showing
 * (see follow.ts). Until there is one, the live page renders its waiting mode: the gathering step
 * with no bubbles. Each switch swaps the token on the same LivePlan, so the page never reloads.
 */
export function WatchPlan({ secret, api }: { secret: string | null; api: string | null }) {
  const server = serverBase(api);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (!secret) return;
    const openedAt = Date.now();
    const url = `${server}/watch/${encodeURIComponent(secret)}/latest`;
    let current: string | null = null;
    let stopped = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return;
        const next = followToken((await res.json()) as WatchLatest, openedAt, current);
        if (!stopped && next !== current) {
          current = next;
          setToken(next);
        }
      } catch {
        // Server unreachable for a moment: keep showing what is up and try again next tick.
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [secret, server]);

  return <LivePlan token={token} replay={null} server={server} />;
}
