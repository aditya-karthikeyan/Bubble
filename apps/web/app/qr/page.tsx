import type { Metadata } from 'next';
import { QrCode } from '../qr-code';
import { siteUrl } from '../site';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Get your bubble' };

/** Full-screen QR for a poster, a projector, or a phone held up at the table. */
export default function QrPoster() {
  const url = siteUrl();
  return (
    <main className="sky poster">
      <h1>Get your bubble</h1>
      <QrCode value={url} label={`QR code for ${url}`} />
      <p className="lede">{url.replace(/^https?:\/\//, '')}</p>
    </main>
  );
}
