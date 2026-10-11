'use client';

import { useEffect, useState } from 'react';
import { SERVER_URL } from './site';

const KEY = 'bubbleworks.watchSecret';

/**
 * The organizer's "Watch live" taskbar button. It stays hidden until the site is opened once with
 * the server's watch secret in the URL fragment (`/#watch=<secret>`). The fragment never reaches
 * a server. The secret is kept in this browser only, the fragment is wiped from the address bar,
 * and `#watch=off` forgets it. The button opens the server's /watch route, which redirects to the
 * newest plan's live page.
 */
export function WatchLive() {
  const [secret, setSecret] = useState<string | null>(null);
  useEffect(() => {
    const read = () => {
      const given = /(?:^#|&)watch=([^&]+)/.exec(window.location.hash)?.[1];
      try {
        if (given === 'off') window.localStorage.removeItem(KEY);
        else if (given) window.localStorage.setItem(KEY, decodeURIComponent(given));
      } catch {
        // Storage blocked (private mode): the button works for this visit only.
      }
      if (given) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      const saved = (() => {
        try {
          return window.localStorage.getItem(KEY);
        } catch {
          return null;
        }
      })();
      setSecret(given && given !== 'off' ? decodeURIComponent(given) : saved);
    };
    read();
    // Pasting the #watch link into a tab that already shows the site doesn't reload it.
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  if (!secret) return null;
  return (
    <a
      className="task live-task"
      href={`${SERVER_URL}/watch/${encodeURIComponent(secret)}`}
      title="Watch the newest real plan live"
    >
      <span className="status-dot" aria-hidden="true" />
      <span className="task-long">Watch live</span>
      <span className="task-short">Live</span>
    </a>
  );
}
