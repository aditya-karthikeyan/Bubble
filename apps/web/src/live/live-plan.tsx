'use client';

import { Arena } from './arena';
import { usePlanFeed, type FeedStatus } from './use-plan-feed';
import { PHASE_COPY, phaseOf } from './view-model';

const STATUS_CHIP: Record<FeedStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
  expired: 'Expired',
  replay: 'Replay',
  replay_done: 'Replay',
};

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function PhaseBanner({
  title,
  line,
  status,
}: {
  title: string;
  line: string;
  status: FeedStatus;
}) {
  return (
    <header className="hud-top">
      <div className="hud-title">
        <h1>{title}</h1>
        <p>{line}</p>
      </div>
      <span className={`chip chip-${status}`}>{STATUS_CHIP[status]}</span>
    </header>
  );
}

function Bokeh() {
  return (
    <div className="bokeh" aria-hidden>
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}

export function LivePlan({ token, replay }: { token: string; replay: string | null }) {
  const { vm, status, restart } = usePlanFeed(token, replay);

  if (status === 'expired') {
    return (
      <main className="sky">
        <div className="wrap">
          <div className="glass expired">
            <h1>This plan page has expired</h1>
            <p className="lede">
              Plan pages close two hours after the plan ends. Text your bubble to start a new one.
            </p>
            <a className="button" href="/">
              Get your bubble
            </a>
          </div>
        </div>
      </main>
    );
  }

  const phase = phaseOf(vm);
  const copy = PHASE_COPY[phase];
  return (
    <main className="stage">
      <Bokeh />
      <Arena vm={vm} phase={phase} />
      <PhaseBanner title={copy.title} line={copy.line} status={status} />
      {status === 'offline' && (
        <p className="hud-alert">Can&apos;t reach Bubbleworks right now. Retrying…</p>
      )}
      {(vm.booking || vm.locked || status === 'replay_done') && (
        <section className="hud-sheet glass" aria-live="polite">
          {vm.booking ? (
            <>
              <h2>Booked</h2>
              <p>
                {vm.booking.venue.name} at {time(vm.booking.startAt)}, table for{' '}
                {vm.booking.partySize} under {vm.booking.reservationName}.
              </p>
            </>
          ) : vm.locked ? (
            <p>
              Going with {vm.locked.venue.name} at {time(vm.locked.startAt)} for{' '}
              {vm.locked.partySize}
              {vm.locked.backup ? `, backup ${vm.locked.backup.name}` : ''}.
            </p>
          ) : null}
          {status === 'replay_done' && (
            <button className="button" type="button" onClick={restart}>
              Replay
            </button>
          )}
        </section>
      )}
    </main>
  );
}
