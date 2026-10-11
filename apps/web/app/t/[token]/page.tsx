import type { Metadata } from 'next';
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
  return (
    <main className="sky ticket-sky">
      <div className="bokeh" aria-hidden>
        {Array.from({ length: 9 }, (_, i) => (
          <span key={i} />
        ))}
      </div>
      <div className="wrap">{ticket ? <Booked t={ticket} /> : <NotFound />}</div>
    </main>
  );
}

function Booked({ t }: { t: Ticket }) {
  return (
    <>
      <header className="hero">
        <div className="orb" aria-hidden />
        <p className="ticket-pill">Booked ✓</p>
        <h1>{t.venueName}</h1>
        {t.address ? <p className="lede">{t.address}</p> : null}
      </header>

      <section className="glass ticket">
        <div className="ticket-when">
          <span className="ticket-time">{t.timeText}</span>
          <span className="ticket-party">Table for {t.partySize}</span>
        </div>
        <div className="ticket-tear" aria-hidden />
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
      </section>

      <a className="button" href={t.mapsUrl}>
        Open in Maps
      </a>
      <a className="button button-glass" href={t.icsUrl}>
        Add to calendar
      </a>
      {t.backupName ? <p className="fine ticket-center">Backup spot: {t.backupName}</p> : null}
      <p className="fine ticket-center">Booked by your bubbles.</p>
    </>
  );
}

function NotFound() {
  return (
    <header className="hero">
      <div className="orb" aria-hidden />
      <h1>Ticket not found</h1>
      <p className="lede">
        That link doesn&apos;t match a booking anymore. The booked message in your chat has the
        latest details.
      </p>
    </header>
  );
}
