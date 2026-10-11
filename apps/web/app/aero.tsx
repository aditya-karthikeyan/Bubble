export function Brand() {
  return (
    <a className="brand" href="/" aria-label="Bubbleworks home">
      <span className="brand-orb" aria-hidden="true" />
      bubbleworks
      <span className="brand-spark" aria-hidden="true">
        ✦
      </span>
    </a>
  );
}

export function Navigation({ live = false }: { live?: boolean }) {
  return (
    <nav className="navigation" aria-label="Main navigation">
      <Brand />
      <div className="nav-links">
        <a href={live ? '/' : '#how-it-works'}>{live ? 'Home' : 'How it works'}</a>
        <a className={live ? 'nav-active' : ''} href="/p/demo?replay=basic">
          Watch the bubbles <span aria-hidden="true">↗</span>
        </a>
        <a className="nav-cta" href="/#get-started">
          Get your bubble <span aria-hidden="true">＋</span>
        </a>
      </div>
    </nav>
  );
}

export function Atmosphere() {
  return (
    <div className="atmosphere" aria-hidden="true">
      <span className="floating-orb float-one" />
      <span className="floating-orb float-two" />
      <span className="floating-orb float-three" />
      <span className="spark spark-one">✦</span>
      <span className="spark spark-two">✦</span>
    </div>
  );
}
