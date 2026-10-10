import { QrCode } from './qr-code';
import { SignupForm } from './signup-form';
import { siteUrl } from './site';

export const dynamic = 'force-dynamic';

export default function Home() {
  const url = siteUrl();
  return (
    <main className="sky">
      <div className="wrap">
        <header className="hero">
          <div className="orb" aria-hidden />
          <h1>Get your bubble</h1>
          <p className="lede">
            A private agent in iMessage that knows what you like. Your crew&apos;s bubbles plan
            dinner together, so you don&apos;t have to.
          </p>
        </header>
        <SignupForm />
        <section className="share">
          <p className="fine">Friends nearby? Have them scan to get their own bubble.</p>
          <div className="qr">
            <QrCode value={url} label={`QR code for ${url}`} />
          </div>
          <p className="fine">
            <a href="/qr">Show full screen</a>
          </p>
        </section>
      </div>
    </main>
  );
}
