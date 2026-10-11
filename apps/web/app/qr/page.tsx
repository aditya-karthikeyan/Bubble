import type { Metadata } from 'next';
import { QrCode } from '../qr-code';
import { siteUrl } from '../site';
import { AeroWindow, Desktop, TaskButton, Taskbar } from '../aero';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Get your bubble' };

/** Full-screen QR for a poster, a projector, or a phone held up at the table. */
export default function QrPoster() {
  const url = siteUrl();
  return (
    <main className="sky poster">
      <Desktop />
      <AeroWindow
        className="poster-window"
        title="Bring your people"
        labelledBy="poster-heading"
        id="bring"
        windowId="qr"
        closeHref="/"
      >
        <div className="poster-card">
          <span className="form-orb" aria-hidden="true" />
          <span className="mini-label">Good company starts here</span>
          <h1 className="instruction" id="poster-heading">
            Bring your people.
          </h1>
          <p className="lede">
            One scan. Your own bubble.
            <br />A whole world of plans together.
          </p>
          <QrCode value={url} label={`QR code for ${url}`} />
          <p className="fine">{url.replace(/^https?:\/\//, '')}</p>
        </div>
        <div className="command-bar">
          <a className="button" href="/">
            Get your bubble <span aria-hidden="true">↗</span>
          </a>
        </div>
      </AeroWindow>
      <Taskbar>
        <TaskButton windowId="qr" href="#bring" className="active">
          <span className="tiny-orb" aria-hidden="true" />
          <span className="task-long">Bring your people</span>
          <span className="task-short">Invite</span>
        </TaskButton>
      </Taskbar>
    </main>
  );
}
