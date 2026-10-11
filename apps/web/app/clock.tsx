'use client';

import { useEffect, useRef, useState } from 'react';

const TEAM = ['Mahil Manoharan', 'Aditya Karthikeyan', 'Pranav Somalraju', 'Soham Patki'];

/**
 * Taskbar clock. It renders after mount, so the server's time zone never shows. Click it for
 * a Windows 7 style calendar flyout with the credits; click outside or press Escape to close.
 */
export function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  if (!now) return <span className="clock" />;
  return (
    <div className="clock-wrap" ref={root}>
      <button
        type="button"
        className={`clock${open ? ' open' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <time dateTime={now.toISOString()}>
          {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </time>
        <span className="clock-date">{now.toLocaleDateString()}</span>
      </button>
      {open && (
        <div className="clock-flyout" role="dialog" aria-label="About Bubbleworks">
          <p className="flyout-date">
            {now.toLocaleDateString([], {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            })}
          </p>
          <div className="flyout-body">
            <span className="flyout-orb" aria-hidden="true" />
            <p className="flyout-label">Made by</p>
            <ul className="flyout-team">
              {TEAM.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
            <p className="flyout-event">
              for <strong>HackNC 2026</strong>
            </p>
          </div>
          <p className="flyout-foot">bubbleworks</p>
        </div>
      )}
    </div>
  );
}
