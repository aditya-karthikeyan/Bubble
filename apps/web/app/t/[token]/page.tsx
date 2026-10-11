import type { Metadata } from 'next';
import { AeroIcon, AeroWindow, Desktop, TaskButton, Taskbar } from '../../aero';
import { SERVER_URL } from '../../site';

export const dynamic = 'force-dynamic';

/** What GET /api/tickets/:token returns (server: web/ticket-page.ts TicketPageData). */
interface Ticket {
  venueName: string;
  address: string | null;
  mapsUrl: string;
  timeText: string;
  partySize: number;
  reservationName: string;
  confirmationCode: string | null;
  members: string[];
  icsUrl: string;
  backupName: string | null;
}

async function loadTicket(token: string): Promise<Ticket | null> {
  try {
    const res = await fetch(`${SERVER_URL}/api/tickets/${encodeURIComponent(token)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok: boolean; ticket?: Ticket };
    return body.ok && body.ticket ? body.ticket : null;
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const ticket = await loadTicket((await params).token);
  return {
    title: ticket ? `${ticket.venueName} · ${ticket.timeText}` : 'Ticket · Bubbleworks',
    description: 'Booked by your bubbles.',
  };
}

export default async function TicketPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ticket = await loadTicket(token);
  const title = ticket ? `Booked ✓ · ${ticket.venueName}` : 'Ticket not found';
  return (
    <main className="sky poster">
      <Desktop />
      <AeroWindow
        className="poster-window ticket-window"
        title={title}
        labelledBy="ticket-heading"
        id="ticket"
        windowId="ticket"
        closeHref="/"
      >
        {ticket ? <Booked t={ticket} /> : <NotFound />}
      </AeroWindow>
      <Taskbar>
        <TaskButton windowId="ticket" href="#ticket" className="active">
          <span className="task-check" aria-hidden="true">
            ✓
          </span>
          <span className="task-long">{ticket ? ticket.venueName : 'Ticket'}</span>
          <span className="task-short">Ticket</span>
        </TaskButton>
      </Taskbar>
    </main>
  );
}

function Booked({ t }: { t: Ticket }) {
  return (
    <>
      <div className="dialog-main">
        <AeroIcon kind="ok">✓</AeroIcon>
        <div>
          <h1 className="instruction" id="ticket-heading">
            {t.venueName}
          </h1>
          {t.address ? <p>{t.address}</p> : null}
        </div>
      </div>
      <div className="ticket">
        <div className="ticket-when">
          <span className="ticket-time">{t.timeText}</span>
          <span className="ticket-party">Table for {t.partySize}</span>
        </div>
        <div className="ticket-tear" aria-hidden="true" />
        <dl className="ticket-rows">
          <div>
            <dt>Name</dt>
            <dd>{t.reservationName}</dd>
          </div>
          {t.confirmationCode ? (
            <div>
              <dt>Confirmation</dt>
              <dd>{t.confirmationCode}</dd>
            </div>
          ) : null}
          {t.backupName ? (
            <div>
              <dt>Backup spot</dt>
              <dd>{t.backupName}</dd>
            </div>
          ) : null}
        </dl>
        {t.members.length ? (
          <>
            <p className="ticket-label">Who&apos;s coming</p>
            <ul className="ticket-who">
              {t.members.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
      <div className="command-bar ticket-actions">
        <a className="win-button" href={t.icsUrl}>
          Add to calendar
        </a>
        <a className="button" href={t.mapsUrl}>
          Open in Maps
        </a>
      </div>
      <div className="status-bar">
        <span>Booked by your bubbles.</span>
      </div>
    </>
  );
}

function NotFound() {
  return (
    <>
      <div className="dialog-main">
        <AeroIcon kind="warn">!</AeroIcon>
        <div>
          <h1 className="instruction" id="ticket-heading">
            Ticket not found
          </h1>
          <p>
            That link doesn&apos;t match a booking anymore. The booked message in your chat has the
            latest details.
          </p>
        </div>
      </div>
      <div className="command-bar">
        <a className="button" href="/">
          Bubbleworks home
        </a>
      </div>
    </>
  );
}
