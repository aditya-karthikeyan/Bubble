/**
 * Windows Vista / 7 Aero pieces shared by every page: the aurora desktop, glass windows,
 * glossy icons, and the taskbar. Everything is drawn in code, and the desktop animates only
 * with compositor transforms so it stays smooth on phones.
 */
import type { ReactNode } from 'react';
import { Clock } from './clock';
import { WatchLive } from './watch-live';

export { AeroWindow, setMinimized, TaskButton } from './aero-window';

export function Brand() {
  return (
    <a className="brand" href="/" aria-label="Bubbleworks home">
      <span className="brand-orb" aria-hidden="true" />
      bubbleworks
    </a>
  );
}

/** Ten strands that fan apart at the tips and pinch together at a knot. */
function strands(count: number, at: (t: number) => string) {
  return Array.from({ length: count }, (_, i) => at(i / (count - 1)));
}

const FEATHER = strands(
  11,
  (t) =>
    `M ${22 + t * 7} ${84 + t * 7} C ${48 + t * 2} ${83 - t * 2} ${70} ${73 + t} ${80 + t * 0.6} ${61 + t * 1.4} ` +
    `S ${94 + t * 1.5} ${22 + t * 3} ${98 + t * 4} ${-3}`,
);
const SPRIG = strands(
  7,
  (t) => `M ${54 + t * 3} ${100} C ${61 + t * 2} ${86} ${68 + t} ${72} ${76 + t * 1.2} ${58 + t}`,
);
const SWEEPS = [
  { d: 'M -5 66 C 30 65 70 69 105 75', w: 3, o: 0.35 },
  { d: 'M -5 77 C 25 79 62 85 105 91', w: 6, o: 0.5 },
  { d: 'M -5 88 C 22 86 46 92 72 104', w: 4, o: 0.45 },
];
const CURTAINS = [
  { d: 'M 6 -5 C 9 25 3 55 -2 85', w: 5, o: 0.5 },
  { d: 'M 17 -5 C 20 20 16 45 10 70', w: 3, o: 0.4 },
  { d: 'M 31 -5 C 33 18 30 38 27 55', w: 7, o: 0.22 },
  { d: 'M 47 -5 C 50 15 47 35 44 50', w: 4, o: 0.26 },
  { d: 'M 64 -5 C 65 18 62 35 60 48', w: 6, o: 0.22 },
  { d: 'M 86 -5 C 84 12 87 28 92 42', w: 5, o: 0.3 },
];
const SPARKLE = 'M12 0C13 8 16 11 24 12C16 13 13 16 12 24C11 16 8 13 0 12C8 11 11 8 12 0Z';

/**
 * The desktop behind every page: an aurora of light ribbons in the Vista style, with bokeh,
 * sparkles, and a few small bubbles rising. Coordinates are percentages of the screen, so the
 * composition holds on a phone in portrait and a wide laptop alike.
 */
export function Desktop() {
  const svg = (className: string, children: ReactNode) => (
    <svg className={`aurora ${className}`} viewBox="0 0 100 100" preserveAspectRatio="none">
      {children}
    </svg>
  );
  return (
    <div className="desktop" aria-hidden="true">
      {svg(
        'aurora-curtains',
        <>
          <defs>
            <linearGradient id="a-curtain" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#9ff5e6" stopOpacity="0" />
              <stop offset="0.3" stopColor="#9ff5e6" stopOpacity="0.8" />
              <stop offset="1" stopColor="#7fd8f0" stopOpacity="0" />
            </linearGradient>
            <filter
              id="a-soft"
              filterUnits="userSpaceOnUse"
              x="-10"
              y="-10"
              width="120"
              height="120"
            >
              <feGaussianBlur stdDeviation="1.6" />
            </filter>
          </defs>
          <g filter="url(#a-soft)" fill="none" stroke="url(#a-curtain)">
            {CURTAINS.map((c) => (
              <path key={c.d} d={c.d} strokeWidth={c.w} opacity={c.o} />
            ))}
          </g>
        </>,
      )}
      {svg(
        'aurora-sweep',
        <>
          <defs>
            <linearGradient id="a-sweep" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#f1ffb0" />
              <stop offset="0.45" stopColor="#ffffff" />
              <stop offset="1" stopColor="#9ef6ff" />
            </linearGradient>
            <linearGradient id="a-ember" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#ffb469" stopOpacity="0.9" />
              <stop offset="0.35" stopColor="#ffd98a" stopOpacity="0" />
            </linearGradient>
            <filter
              id="a-glow"
              filterUnits="userSpaceOnUse"
              x="-10"
              y="-10"
              width="120"
              height="120"
            >
              <feGaussianBlur stdDeviation="1.1" />
            </filter>
          </defs>
          <g filter="url(#a-glow)" fill="none" stroke="url(#a-sweep)">
            {SWEEPS.map((s) => (
              <path key={s.d} d={s.d} strokeWidth={s.w} opacity={s.o} />
            ))}
          </g>
          <g fill="none" stroke="url(#a-sweep)" vectorEffect="non-scaling-stroke">
            {SWEEPS.flatMap((s, i) =>
              [0, 0.7, 1.5].map((dy) => (
                <path
                  key={`${i}:${dy}`}
                  d={s.d}
                  transform={`translate(0 ${dy})`}
                  strokeWidth={1}
                  opacity={0.35 + s.o * 0.5}
                  vectorEffect="non-scaling-stroke"
                />
              )),
            )}
          </g>
          <path
            d="M -5 62 C 15 62 30 63 50 66"
            fill="none"
            stroke="url(#a-ember)"
            strokeWidth={1.2}
            vectorEffect="non-scaling-stroke"
          />
        </>,
      )}
      {svg(
        'aurora-feather',
        <>
          <defs>
            <linearGradient
              id="a-feather"
              gradientUnits="userSpaceOnUse"
              x1="20"
              y1="92"
              x2="100"
              y2="0"
            >
              <stop offset="0" stopColor="#e8ff8f" stopOpacity="0" />
              <stop offset="0.18" stopColor="#d4f76a" stopOpacity="0.85" />
              <stop offset="0.45" stopColor="#a6efa0" stopOpacity="0.9" />
              <stop offset="0.7" stopColor="#7fdfff" stopOpacity="0.85" />
              <stop offset="1" stopColor="#bdf3ff" stopOpacity="0.15" />
            </linearGradient>
            <linearGradient id="a-sprig" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#c8f560" stopOpacity="0.1" />
              <stop offset="0.5" stopColor="#c9f86e" stopOpacity="0.9" />
              <stop offset="1" stopColor="#8ff0d0" stopOpacity="0.3" />
            </linearGradient>
          </defs>
          <g fill="none" stroke="url(#a-feather)" filter="url(#a-glow)" opacity={0.45}>
            {FEATHER.filter((_, i) => i % 3 === 0).map((d) => (
              <path key={d} d={d} strokeWidth={1.4} />
            ))}
          </g>
          <g fill="none" stroke="url(#a-feather)">
            {FEATHER.map((d, i) => (
              <path
                key={d}
                d={d}
                strokeWidth={i % 4 === 0 ? 2 : 1.1}
                opacity={0.45 + ((i * 7) % 5) * 0.11}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
          <g fill="none" stroke="url(#a-sprig)">
            {SPRIG.map((d, i) => (
              <path
                key={d}
                d={d}
                strokeWidth={i % 3 === 0 ? 2.4 : 1.2}
                opacity={0.55 + (i % 3) * 0.15}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        </>,
      )}
      <div className="glare" />
      <div className="bokeh">
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} />
        ))}
      </div>
      <div className="sparkles">
        {Array.from({ length: 7 }, (_, i) => (
          <svg key={i} viewBox="0 0 24 24">
            <path d={SPARKLE} />
          </svg>
        ))}
      </div>
      <div className="rising">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} />
        ))}
      </div>
    </div>
  );
}

/** Glossy round icon: blue info, green check, amber warning. */
export function AeroIcon({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'ok' | 'warn';
  children: ReactNode;
}) {
  return (
    <span className={`aero-icon aero-icon-${kind}`} aria-hidden="true">
      {children}
    </span>
  );
}

/** The taskbar: a start orb that goes home, task buttons, and a tray with the clock. */
export function Taskbar({ children, tray }: { children?: ReactNode; tray?: ReactNode }) {
  return (
    <nav className="taskbar" aria-label="Bubbleworks">
      <a className="start-orb" href="/" aria-label="Bubbleworks home">
        <span />
      </a>
      <div className="tasks">
        <WatchLive />
        {children}
      </div>
      <div className="tray">
        {tray}
        <Clock />
      </div>
    </nav>
  );
}
