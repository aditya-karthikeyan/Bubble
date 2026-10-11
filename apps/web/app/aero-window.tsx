'use client';

/**
 * Win7 glass windows you can actually use: drag them by the title bar, click one to bring it
 * to the front, and minimize or close them into the taskbar, whose buttons bring them back.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from 'react';

/** Which windows are minimized, by id, so taskbar buttons and windows share it. */
const minimizedIds = new Set<string>();
const listeners = new Set<() => void>();

export function setMinimized(id: string, minimized: boolean) {
  if (minimized) minimizedIds.add(id);
  else minimizedIds.delete(id);
  listeners.forEach((l) => l());
}

function useMinimized(id: string | undefined) {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (id ? minimizedIds.has(id) : false),
    () => false,
  );
}

/** Windows stack in the order they were last touched; the taskbar always stays on top. */
let topZ = 20;
const raise = (el: HTMLElement) => {
  el.style.zIndex = String(++topZ);
};

/** Caption-button glyph: a dark outline under a white stroke, like Win7's. */
function Glyph({ kind }: { kind: 'min' | 'max' | 'close' }) {
  const d =
    kind === 'min'
      ? 'M2.5 8.5h6'
      : kind === 'max'
        ? 'M2 2.5h7v6h-7zM2 3.6h7'
        : 'M2.5 2.5l6 6M8.5 2.5l-6 6';
  return (
    <svg viewBox="0 0 11 11" width="11" height="11" aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke="#14243a"
        strokeWidth={kind === 'close' ? 3.4 : 3}
        opacity={0.7}
      />
      <path d={d} fill="none" stroke="#fff" strokeWidth={kind === 'close' ? 1.8 : 1.4} />
    </svg>
  );
}

function CaptionButton({
  kind,
  label,
  onClick,
  href,
}: {
  kind: 'min' | 'max' | 'close';
  label: string;
  onClick?: () => void;
  href?: string;
}) {
  if (href)
    return (
      <a className={`cap cap-${kind}`} aria-label={label} href={href}>
        <Glyph kind={kind} />
      </a>
    );
  return onClick ? (
    <button type="button" className={`cap cap-${kind}`} aria-label={label} onClick={onClick}>
      <Glyph kind={kind} />
    </button>
  ) : (
    <span className={`cap cap-${kind}`} aria-hidden="true">
      <Glyph kind={kind} />
    </span>
  );
}

/**
 * A Win7 glass window: title bar with a white text glow, caption buttons, and a white client
 * area. `controls="dialog"` shows only Close. The maximize button is always disabled, as on a
 * fixed-size dialog. With a `windowId` and no handlers, minimize and close send the window to
 * the taskbar (a `TaskButton` with the same id restores it); `closeHref` makes Close a link.
 */
export function AeroWindow({
  title,
  icon,
  controls = 'window',
  onMinimize,
  onClose,
  closeHref,
  minimized: minimizedProp,
  windowId,
  id,
  labelledBy,
  className,
  style,
  bar,
  onRect,
  children,
}: {
  title: string;
  icon?: ReactNode;
  controls?: 'window' | 'dialog';
  onMinimize?: () => void;
  onClose?: () => void;
  closeHref?: string;
  /** Shrunk into the taskbar: hidden from view, focus, and screen readers. */
  minimized?: boolean;
  windowId?: string;
  id?: string;
  labelledBy?: string;
  className?: string;
  style?: CSSProperties;
  /** Glass toolbar row under the title, like Explorer's address bar. */
  bar?: ReactNode;
  /** Told where the window sits on screen whenever it moves or resizes; null once hidden. */
  onRect?: (rect: DOMRect | null) => void;
  children: ReactNode;
}) {
  const stored = useMinimized(windowId);
  const minimized = minimizedProp ?? stored;
  const toTaskbar = windowId ? () => setMinimized(windowId, true) : undefined;
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const offset = useRef({ x: 0, y: 0 });

  const report = useCallback(() => {
    if (!onRect) return;
    onRect(minimized || !ref.current ? null : ref.current.getBoundingClientRect());
  }, [onRect, minimized]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !onRect) return;
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    window.addEventListener('resize', report);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
      onRect(null);
    };
  }, [onRect, report]);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.caption')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      id: e.pointerId,
      x: e.clientX - offset.current.x,
      y: e.clientY - offset.current.y,
    };
    ref.current?.classList.add('dragging');
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || d.id !== e.pointerId || !el) return;
    const box = el.getBoundingClientRect();
    const baseLeft = box.left - offset.current.x;
    const baseTop = box.top - offset.current.y;
    // Keep enough of the title bar on screen to grab it again.
    const x = Math.min(
      window.innerWidth - baseLeft - 80,
      Math.max(80 - baseLeft - box.width, e.clientX - d.x),
    );
    const y = Math.min(window.innerHeight - baseTop - 72, Math.max(-baseTop, e.clientY - d.y));
    offset.current = { x, y };
    el.style.setProperty('--dx', `${x}px`);
    el.style.setProperty('--dy', `${y}px`);
    report();
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    ref.current?.classList.remove('dragging');
    report();
  };

  return (
    <section
      ref={ref}
      id={id}
      aria-labelledby={labelledBy}
      className={`aero-window${minimized ? ' minimized' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      inert={minimized}
      onPointerDownCapture={(e) => raise(e.currentTarget)}
    >
      <div
        className="aero-titlebar"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        {icon ?? <span className="tiny-orb" aria-hidden="true" />}
        <span className="aero-title">{title}</span>
        <div className="caption">
          {controls === 'window' && (
            <CaptionButton kind="min" label="Minimize" onClick={onMinimize ?? toTaskbar} />
          )}
          {controls === 'window' && <CaptionButton kind="max" label="Maximize" />}
          <CaptionButton
            kind="close"
            label="Close"
            href={closeHref}
            onClick={onClose ?? toTaskbar}
          />
        </div>
      </div>
      {bar}
      <div className="aero-client">{children}</div>
    </section>
  );
}

/**
 * A taskbar button for a window: it brings the window back if it was minimized, then follows
 * its link (for example, scrolling to it).
 */
export function TaskButton({
  windowId,
  href,
  className,
  children,
}: {
  windowId: string;
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const minimized = useMinimized(windowId);
  return (
    <a
      className={`task${className && !minimized ? ` ${className}` : ''}`}
      href={href}
      onClick={() => setMinimized(windowId, false)}
    >
      {children}
    </a>
  );
}
