'use client';

import { useEffect, useState } from 'react';

/** Taskbar clock. It renders after mount, so the server's time zone never shows. */
export function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }, []);
  if (!now) return <span className="clock" />;
  return (
    <time className="clock" dateTime={now.toISOString()}>
      <span>{now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
      <span className="clock-date">{now.toLocaleDateString()}</span>
    </time>
  );
}
