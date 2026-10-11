'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Arena } from './arena';
import { AeroIcon, AeroWindow, Desktop, Taskbar } from '../../app/aero';
import { floatingWindows } from './layout';
import type { Rect } from './physics';
import { STEPS, stepOf, stepSummary } from './steps';
import { usePlanFeed, type FeedStatus } from './use-plan-feed';
import { PHASE_COPY, phaseOf, type Phase, type ViewModel } from './view-model';

const STATUS_CHIP: Record<FeedStatus, string> = {
  // The organizer's /watch page before a plan starts: it is following the server, just idle.
  waiting: 'Live',
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
  expired: 'Expired',
  replay: 'Replay',
  replay_done: 'Replay',
};

const PHASE_ICON: Record<Phase, { kind: 'info' | 'ok' | 'warn'; glyph: string }> = {
  gathering: { kind: 'info', glyph: 'i' },
  candidates: { kind: 'info', glyph: 'i' },
  convergence: { kind: 'info', glyph: 'i' },
  deadlock: { kind: 'warn', glyph: '?' },
  locked: { kind: 'ok', glyph: '✓' },
  summary: { kind: 'ok', glyph: '✓' },
  complete: { kind: 'ok', glyph: '✓' },
  closed: { kind: 'warn', glyph: '!' },
};

type WindowId = 'plan' | 'locked' | 'booked' | 'done';
const WINDOW_IDS: WindowId[] = ['plan', 'locked', 'booked', 'done'];
/** Widths match the .floating rules in globals.css; heights are estimates for placement. */
const WINDOW_SIZE: Record<WindowId, { w: number; h: number }> = {
  plan: { w: 500, h: 190 },
  locked: { w: 400, h: 150 },
  booked: { w: 400, h: 200 },
  done: { w: 400, h: 150 },
};

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Where a window pops up on the desktop: a random corner, nudged a little, clear of the
 * windows already open. The plan window takes a top corner; dialogs prefer the bottom.
 */
function pickSpot(id: WindowId, open: Rect[]): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const { w, h } = WINDOW_SIZE[id];
  const corners = (id === 'plan' ? ['tl', 'tr'] : ['bl', 'br', 'tr', 'tl']).sort(
    () => Math.random() - 0.5,
  );
  if (id !== 'plan') corners.sort((a, b) => Number(a[0] === 't') - Number(b[0] === 't'));
  const spots = corners.map((c) => {
    const x = c[1] === 'l' ? 16 + Math.random() * 90 : vw - w - 16 - Math.random() * 90;
    const fromBottom = 58 + Math.random() * 50;
    const y = c[0] === 't' ? 16 + Math.random() * 50 : vh - fromBottom - h;
    return {
      rect: { x, y, w, h },
      style: (c[0] === 't'
        ? { left: x, top: y }
        : { left: x, bottom: fromBottom }) satisfies CSSProperties,
    };
  });
  return (spots.find((s) => !open.some((r) => overlaps(s.rect, r))) ?? spots[0]!).style;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Explorer-style address bar on the window's glass: round Back and Forward buttons and a
 * breadcrumb of the four plan steps. Every step reached so far is clickable and opens that
 * step's page; the current step (or the orb) goes back to the live view.
 */
function Breadcrumb({
  at,
  viewing,
  onView,
}: {
  at: number;
  viewing: number | null;
  onView: (step: number | null) => void;
}) {
  const shown = viewing ?? at;
  const go = (step: number) => onView(step >= at ? null : Math.max(0, step));
  return (
    <div className="address-bar">
      <div className="nav-buttons">
        <button
          type="button"
          className="nav-back"
          aria-label="Back"
          disabled={shown <= 0}
          onClick={() => go(shown - 1)}
        />
        <button
          type="button"
          className="nav-forward"
          aria-label="Forward"
          disabled={viewing === null}
          onClick={() => go(shown + 1)}
        />
      </div>
      <ol className="crumbs" aria-label="Plan steps">
        <li className="crumb-root">
          <button type="button" aria-label="Live view" onClick={() => onView(null)}>
            <span className="tiny-orb" />
          </button>
        </li>
        {STEPS.map((s, i) => (
          <li
            key={s.long}
            className={`${i === at ? 'current' : i < at ? 'past' : 'future'}${i === shown ? ' shown' : ''}`}
          >
            <button
              type="button"
              disabled={i > at}
              aria-current={i === shown ? 'page' : undefined}
              onClick={() => go(i)}
            >
              <span className="task-long">{s.long}</span>
              <span className="task-short">{s.short}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function PhaseBanner({
  vm,
  phase,
  bubbles,
  minimized,
  onMinimize,
  className,
  style,
  onRect,
}: {
  vm: ViewModel;
  phase: Phase;
  bubbles: number;
  minimized: boolean;
  onMinimize: () => void;
  className?: string;
  style?: CSSProperties;
  onRect?: (rect: DOMRect | null) => void;
}) {
  const [viewing, setViewing] = useState<number | null>(null);
  const at = stepOf(phase);
  const copy = PHASE_COPY[phase];
  const icon = PHASE_ICON[phase];
  const page = viewing === null ? null : stepSummary(viewing, vm);
  return (
    <AeroWindow
      className={`hud-top popup${className ? ` ${className}` : ''}`}
      style={style}
      onRect={onRect}
      title="Bubbleworks · Live plan"
      labelledBy="phase-title"
      minimized={minimized}
      onMinimize={onMinimize}
      onClose={onMinimize}
      bar={<Breadcrumb at={at} viewing={viewing} onView={setViewing} />}
    >
      {page ? (
        <div className="dialog-main">
          <AeroIcon>i</AeroIcon>
          <div>
            <h1 className="instruction" id="phase-title">
              {page.title}
            </h1>
            {page.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <button type="button" className="link-button" onClick={() => setViewing(null)}>
              Back to live: {copy.title}
            </button>
          </div>
        </div>
      ) : (
        <div className="dialog-main" aria-live="polite">
          <AeroIcon kind={icon.kind}>{icon.glyph}</AeroIcon>
          <div>
            <h1 className="instruction" id="phase-title">
              {copy.title}
            </h1>
            <p>{copy.line}</p>
          </div>
        </div>
      )}
      <div className="status-bar">
        <span>
          {bubbles} {bubbles === 1 ? 'bubble' : 'bubbles'}
        </span>
        <span className="privacy-label">Your preferences stay private.</span>
      </div>
    </AeroWindow>
  );
}

/**
 * The live plan page. `token` null is the waiting mode used by the organizer's /watch page: the
 * same desktop, arena and plan window at the gathering step with no bubbles, until a token
 * arrives. Changing `token` switches the feed in place (new socket room, history recap) without
 * remounting the page. `server` overrides NEXT_PUBLIC_SOCKET_URL for the socket.
 */
export function LivePlan({
  token,
  replay,
  server,
}: {
  token: string | null;
  replay: string | null;
  server?: string;
}) {
  // The arena tells the feed when its animations finish, so each step waits for the last.
  const settled = useRef<(() => boolean) | null>(null);
  const { vm, status, restart, run } = usePlanFeed(token, replay, settled, server);
  const [hudMinimized, setHudMinimized] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  // Desktop windows pop up at random spots and float; the arena keeps bubbles out from under them.
  const [floating, setFloating] = useState(false);
  const [spots, setSpots] = useState<Partial<Record<WindowId, CSSProperties>>>({});
  // A new plan starts with no dialogs: forget dismissals and dialog spots, keep the plan window.
  const [shownToken, setShownToken] = useState(token);
  if (shownToken !== token) {
    setShownToken(token);
    setDismissed(null);
    setSpots((sp) => (sp.plan ? { plan: sp.plan } : {}));
  }
  const rects = useRef<Partial<Record<WindowId, Rect>>>({});
  const windows = useRef<Rect[]>([]);
  const track = useMemo(
    () =>
      Object.fromEntries(
        WINDOW_IDS.map((id) => [
          id,
          (r: DOMRect | null) => {
            if (r) rects.current[id] = { x: r.left, y: r.top, w: r.width, h: r.height };
            else delete rects.current[id];
            windows.current = Object.values(rects.current);
          },
        ]),
      ) as Record<WindowId, (r: DOMRect | null) => void>,
    [],
  );
  useEffect(() => {
    const on = () => setFloating(floatingWindows({ w: window.innerWidth, h: window.innerHeight }));
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const sheet: WindowId | null = vm.booking
    ? 'booked'
    : vm.locked
      ? 'locked'
      : status === 'replay_done'
        ? 'done'
        : null;
  // Each window gets its spot the first time it opens, clear of the ones already up.
  useEffect(() => {
    if (!floating) return;
    setSpots((sp) => {
      if (sp.plan && (!sheet || sp[sheet])) return sp;
      const next = { ...sp };
      next.plan ??= pickSpot('plan', []);
      if (sheet) next[sheet] ??= pickSpot(sheet, Object.values(rects.current));
      return next;
    });
  }, [floating, sheet]);
  // Floating windows wait for their spot, so they never flash in the docked position first.
  const placed = (id: WindowId): CSSProperties | undefined =>
    floating ? (spots[id] ?? { visibility: 'hidden' }) : undefined;

  if (status === 'expired') {
    return (
      <main className="sky poster">
        <Desktop />
        <AeroWindow className="poster-window" title="Bubbleworks" controls="dialog" closeHref="/">
          <div className="dialog-main">
            <AeroIcon kind="warn">!</AeroIcon>
            <div>
              <h1 className="instruction">This plan page has expired</h1>
              <p>
                Plan pages close two hours after the plan ends. Text your bubble to start a new one.
              </p>
            </div>
          </div>
          <div className="command-bar">
            <a className="button" href="/">
              Get your bubble
            </a>
          </div>
        </AeroWindow>
        <Taskbar />
      </main>
    );
  }

  const phase = phaseOf(vm);
  const sheetOpen = sheet !== null && sheet !== dismissed;
  const again = () => {
    setDismissed(null);
    setSpots((sp) => ({ plan: sp.plan }));
    restart();
  };
  const bubbles = vm.bubbles.filter((b) => b.present).length;
  const live =
    status === 'live' || status === 'waiting' || status === 'replay' || status === 'replay_done';
  return (
    <main className="stage">
      <Desktop />
      <Arena
        key={`${token}:${replay}:${run}`}
        vm={vm}
        phase={phase}
        windows={windows}
        settled={settled}
      />
      <PhaseBanner
        vm={vm}
        phase={phase}
        bubbles={bubbles}
        minimized={hudMinimized}
        onMinimize={() => setHudMinimized(true)}
        className={floating ? 'floating' : undefined}
        style={placed('plan')}
        onRect={track.plan}
      />
      {status === 'offline' && (
        <div className="balloon" role="status">
          <strong>Connection lost</strong>
          Can&apos;t reach Bubbleworks right now. Retrying…
        </div>
      )}
      {sheetOpen && (
        <AeroWindow
          key={sheet}
          className={`hud-sheet popup${floating ? ' floating' : ''}`}
          style={placed(sheet)}
          onRect={track[sheet]}
          title={sheet === 'booked' ? 'Booked' : sheet === 'locked' ? 'Plan locked' : 'Replay'}
          controls="dialog"
          labelledBy="sheet-title"
          onClose={() => setDismissed(sheet)}
        >
          <div className="dialog-main" aria-live="polite">
            <AeroIcon kind={sheet === 'done' ? 'info' : 'ok'}>
              {sheet === 'done' ? 'i' : '✓'}
            </AeroIcon>
            <div>
              {vm.booking ? (
                <>
                  <h2 className="instruction" id="sheet-title">
                    Booked
                  </h2>
                  <p>
                    {vm.booking.venue.name} at {time(vm.booking.startAt)}, table for{' '}
                    {vm.booking.partySize} under {vm.booking.reservationName}.
                  </p>
                </>
              ) : vm.locked ? (
                <>
                  <h2 className="instruction" id="sheet-title">
                    Going with {vm.locked.venue.name}
                  </h2>
                  <p>
                    {time(vm.locked.startAt)} for {vm.locked.partySize}
                    {vm.locked.backup ? `, backup ${vm.locked.backup.name}` : ''}.
                  </p>
                </>
              ) : (
                <h2 className="instruction" id="sheet-title">
                  That&apos;s the whole plan.
                </h2>
              )}
            </div>
          </div>
          {status === 'replay_done' && (
            <div className="command-bar">
              <button className="button" type="button" onClick={again}>
                Replay
              </button>
            </div>
          )}
        </AeroWindow>
      )}
      <Taskbar
        tray={
          <span className={`tray-status tray-${status}`} title={STATUS_CHIP[status]}>
            <span className={`status-dot${live ? '' : ' off'}`} />
            <span className="tray-label">{STATUS_CHIP[status]}</span>
          </span>
        }
      >
        <button
          type="button"
          className={`task${hudMinimized ? '' : ' active'}`}
          aria-pressed={!hudMinimized}
          onClick={() => setHudMinimized((m) => !m)}
        >
          <span className="tiny-orb" aria-hidden="true" />
          Live plan
        </button>
        {sheet && !sheetOpen && (
          <button type="button" className="task" onClick={() => setDismissed(null)}>
            <span className="task-check" aria-hidden="true">
              ✓
            </span>
            {sheet === 'booked' ? 'Booked' : sheet === 'locked' ? 'Locked' : 'Replay'}
          </button>
        )}
        {replay && (
          <button type="button" className="task" onClick={again}>
            <span aria-hidden="true">↻</span>
            <span className="task-long">Restart demo</span>
            <span className="task-short">Restart</span>
          </button>
        )}
      </Taskbar>
    </main>
  );
}
