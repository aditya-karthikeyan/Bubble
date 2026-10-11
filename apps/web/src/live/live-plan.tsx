'use client';

import { useState } from 'react';
import { Arena } from './arena';
import { AeroIcon, AeroWindow, Desktop, Taskbar } from '../../app/aero';
import { usePlanFeed, type FeedStatus } from './use-plan-feed';
import { PHASE_COPY, phaseOf, type Phase } from './view-model';

const STATUS_CHIP: Record<FeedStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
  expired: 'Expired',
  replay: 'Replay',
  replay_done: 'Replay',
};

const STEPS: { long: string; short: string; phases: Phase[] }[] = [
  { long: 'Gather', short: 'Gather', phases: ['gathering'] },
  { long: 'Find a place', short: 'Find', phases: ['candidates', 'convergence', 'deadlock'] },
  { long: 'Make it happen', short: 'Book', phases: ['locked'] },
  { long: 'See you there', short: 'Done', phases: ['summary', 'complete'] },
];

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

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Explorer-style breadcrumb of the four plan steps, on the window's glass. */
function Breadcrumb({ phase }: { phase: Phase }) {
  const at = STEPS.findIndex((s) => s.phases.includes(phase));
  return (
    <div className="address-bar">
      <ol className="crumbs" aria-label="Plan progress">
        <li className="crumb-root" aria-hidden="true">
          <span className="tiny-orb" />
        </li>
        {STEPS.map((s, i) => (
          <li
            key={s.long}
            className={i === at ? 'current' : i < at ? 'past' : undefined}
            aria-current={i === at ? 'step' : undefined}
          >
            <span className="task-long">{s.long}</span>
            <span className="task-short">{s.short}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function PhaseBanner({
  phase,
  bubbles,
  minimized,
  onMinimize,
}: {
  phase: Phase;
  bubbles: number;
  minimized: boolean;
  onMinimize: () => void;
}) {
  const copy = PHASE_COPY[phase];
  const icon = PHASE_ICON[phase];
  return (
    <AeroWindow
      className="hud-top"
      title="Bubbleworks · Live plan"
      labelledBy="phase-title"
      minimized={minimized}
      onMinimize={onMinimize}
      onClose={onMinimize}
      bar={<Breadcrumb phase={phase} />}
    >
      <div className="dialog-main" aria-live="polite">
        <AeroIcon kind={icon.kind}>{icon.glyph}</AeroIcon>
        <div>
          <h1 className="instruction" id="phase-title">
            {copy.title}
          </h1>
          <p>{copy.line}</p>
        </div>
      </div>
      <div className="status-bar">
        <span>
          {bubbles} {bubbles === 1 ? 'bubble' : 'bubbles'}
        </span>
        <span className="privacy-label">Your preferences stay private.</span>
      </div>
    </AeroWindow>
  );
}

export function LivePlan({ token, replay }: { token: string; replay: string | null }) {
  const { vm, status, restart, run } = usePlanFeed(token, replay);
  const [hudMinimized, setHudMinimized] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (status === 'expired') {
    return (
      <main className="sky poster">
        <Desktop />
        <AeroWindow className="poster-window" title="Bubbleworks" controls="dialog">
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
  const sheet = vm.booking
    ? 'booked'
    : vm.locked
      ? 'locked'
      : status === 'replay_done'
        ? 'done'
        : null;
  const sheetOpen = sheet !== null && sheet !== dismissed;
  const again = () => {
    setDismissed(null);
    restart();
  };
  const bubbles = vm.bubbles.filter((b) => b.present).length;
  const live = status === 'live' || status === 'replay' || status === 'replay_done';
  return (
    <main className="stage">
      <Desktop />
      <Arena key={`${token}:${replay}:${run}`} vm={vm} phase={phase} />
      <PhaseBanner
        phase={phase}
        bubbles={bubbles}
        minimized={hudMinimized}
        onMinimize={() => setHudMinimized(true)}
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
          className="hud-sheet"
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
