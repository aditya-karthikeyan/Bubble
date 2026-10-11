import { Atmosphere, Navigation } from './aero';
import { QrCode } from './qr-code';
import { SignupForm } from './signup-form';
import { siteUrl } from './site';

export const dynamic = 'force-dynamic';

export default function Home() {
  const url = siteUrl();
  return (
    <main className="sky home">
      <Atmosphere />
      <Navigation />
      <div className="home-grid">
        <section className="hero">
          <div className="eyebrow">
            <span className="status-dot" /> A little less planning. A lot more living.
          </div>
          <h1>
            Good plans.
            <br />
            Great company.
            <br />
            <span>Just bubble.</span>
          </h1>
          <p className="lede">
            Your own little agent. Your whole crew in sync.
            <br className="desktop-break" /> Turn “dinner tonight?” into “see you there.”
          </p>
          <a className="demo-link" href="/p/demo?replay=basic">
            <span className="play-icon" aria-hidden="true">
              ▶
            </span>
            <span>
              See the bubbles in action<small>A little teamwork. A little magic.</small>
            </span>
            <span aria-hidden="true">↗</span>
          </a>
          <div className="hero-scene" aria-hidden="true">
            <div className="message-pill message-one">
              dinner tonight? <span>↗</span>
            </div>
            <div className="hero-bubble">
              <span>
                let&apos;s
                <br />
                go out.
              </span>
            </div>
            <div className="satellite satellite-green" />
            <div className="satellite satellite-small" />
            <div className="message-pill message-two">
              <span className="status-dot" /> Your crew. All on the same wavelength.
            </div>
          </div>
        </section>
        <section className="signup-window glass" id="get-started" aria-labelledby="signup-heading">
          <div className="window-bar">
            <span>
              <span className="tiny-orb" /> YOUR LITTLE CORNER OF THE WORLD
            </span>
            <span className="window-dots" aria-hidden="true">
              •••
            </span>
          </div>
          <div className="signup-inner">
            <div className="form-heading">
              <span className="form-orb" aria-hidden="true" />
              <span className="mini-label">MADE FOR YOU. CONNECTED TO YOUR CREW.</span>
              <h2 id="signup-heading">Meet your bubble.</h2>
              <p>
                A private agent that gets you.
                <br />
                Right at home in iMessage.
              </p>
            </div>
            <SignupForm />
          </div>
          <div className="window-footer">
            <span className="status-dot" /> A brighter way to make plans{' '}
            <span aria-hidden="true">✧</span>
          </div>
        </section>
      </div>
      <section className="how-section glass" id="how-it-works" aria-labelledby="how-heading">
        <div className="how-intro">
          <span className="mini-label">LIFE OUTSIDE THE GROUP CHAT</span>
          <h2 id="how-heading">
            Less back-and-forth.
            <br />
            More being there.
          </h2>
        </div>
        <div className="how-step">
          <span className="step-orb">01</span>
          <h3>Make it yours</h3>
          <p>
            Get your bubble number. A few texts help it learn your tastes, budget, and boundaries.
          </p>
        </div>
        <div className="how-step">
          <span className="step-orb green">02</span>
          <h3>Bring your people</h3>
          <p>Your crew&apos;s bubbles find the places that work for everyone, together.</p>
        </div>
        <div className="how-step">
          <span className="step-orb violet">03</span>
          <h3>Go make a memory</h3>
          <p>From picking a spot to booking the table, your bubbles handle the details.</p>
        </div>
      </section>
      <footer className="home-footer">
        <p>
          Small bubbles. <strong>A world of possibilities.</strong>
        </p>
        <a className="share-link" href="/qr">
          <span className="mini-qr">
            <QrCode value={url} label="Scan to get your bubble" />
          </span>
          <span>
            Better with your people.<small>Scan or tap to invite your crew ↗</small>
          </span>
        </a>
        <span className="footer-note">Made for real-life connections. ✦</span>
      </footer>
    </main>
  );
}
