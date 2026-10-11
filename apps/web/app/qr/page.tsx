import type { Metadata } from 'next';
import { QrCode } from '../qr-code';
import { siteUrl } from '../site';
import { Atmosphere, Navigation } from '../aero';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Get your bubble' };

/** Full-screen QR for a poster, a projector, or a phone held up at the table. */
export default function QrPoster() {
  const url = siteUrl();
  return (
    <main className="sky poster">
      <Atmosphere />
      <Navigation live />
      <div className="poster-card glass">
        <span className="form-orb" aria-hidden="true" />
        <span className="mini-label">GOOD COMPANY STARTS HERE</span>
        <h1>Bring your people.</h1>
        <p className="lede">
          One scan. Your own bubble.
          <br />A whole world of plans together.
        </p>
        <QrCode value={url} label={`QR code for ${url}`} />
        <p className="fine">{url.replace(/^https?:\/\//, '')}</p>
        <a className="button" href="/">
          Get your bubble <span aria-hidden="true">↗</span>
        </a>
      </div>
    </main>
  );
}
