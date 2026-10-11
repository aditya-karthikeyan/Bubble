import { AeroIcon, AeroWindow, Brand, Desktop, Taskbar } from './aero';
import { QrCode } from './qr-code';
import { SignupForm } from './signup-form';
import { siteUrl } from './site';

export const dynamic = 'force-dynamic';

export default function Home() {
  const url = siteUrl();
  return (
    <main className="sky home">
      <Desktop />
      <div className="home-grid">
        <section className="hero">
          <Brand />
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
            <span className="play-icon" aria-hidden="true" />
            <span>
              See the bubbles in action<small>A little teamwork. A little magic.</small>
            </span>
          </a>
          <div className="hero-scene" aria-hidden="true">
            <div className="message-pill message-one">dinner tonight?</div>
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
        <AeroWindow
          className="signup-window"
          id="get-started"
          labelledBy="signup-heading"
          title="Get your bubble"
        >
          <div className="signup-inner">
            <div className="form-heading">
              <span className="form-orb" aria-hidden="true" />
              <h2 className="instruction" id="signup-heading">
                Meet your bubble.
              </h2>
              <p>
                A private agent that gets you.
                <br />
                Right at home in iMessage.
              </p>
            </div>
            <SignupForm />
          </div>
          <div className="status-bar">
            <span className="status-dot" /> A brighter way to make plans
          </div>
        </AeroWindow>
      </div>
      <AeroWindow
        className="how-window"
        id="how-it-works"
        labelledBy="how-heading"
        title="How it works"
      >
        <div className="dialog-main">
          <AeroIcon>i</AeroIcon>
          <div>
            <span className="mini-label">Life outside the group chat</span>
            <h2 className="instruction" id="how-heading">
              Less back-and-forth. More being there.
            </h2>
          </div>
        </div>
        <div className="mint how-steps">
          <div className="how-step">
            <span className="step-orb">1</span>
            <h3>Make it yours</h3>
            <p>
              Get your bubble number. A few texts help it learn your tastes, budget, and boundaries.
            </p>
          </div>
          <div className="how-step">
            <span className="step-orb green">2</span>
            <h3>Bring your people</h3>
            <p>Your crew&apos;s bubbles find the places that work for everyone, together.</p>
          </div>
          <div className="how-step">
            <span className="step-orb violet">3</span>
            <h3>Go make a memory</h3>
            <p>From picking a spot to booking the table, your bubbles handle the details.</p>
          </div>
        </div>
      </AeroWindow>
      <footer className="home-footer">
        <p>
          Small bubbles. <strong>A world of possibilities.</strong>
        </p>
        <a className="gadget" href="/qr">
          <span className="mini-qr">
            <QrCode value={url} label="Scan to get your bubble" />
          </span>
          <span>
            Better with your people.<small>Scan or tap to invite your crew</small>
          </span>
        </a>
      </footer>
      <Taskbar>
        <a className="task" href="#get-started">
          <span className="tiny-orb" aria-hidden="true" />
          <span className="task-long">Get your bubble</span>
          <span className="task-short">Sign up</span>
        </a>
        <a className="task" href="#how-it-works">
          <span className="task-long">How it works</span>
          <span className="task-short">How</span>
        </a>
        <a className="task" href="/p/demo?replay=basic">
          <span className="task-play" aria-hidden="true" />
          <span className="task-long">Watch the bubbles</span>
          <span className="task-short">Demo</span>
        </a>
      </Taskbar>
    </main>
  );
}
