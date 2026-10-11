'use client';

/**
 * Full-screen deliberation arena. Every bubble, venue orb, and doer is a node in one d3-force
 * simulation that never fully cools: each node picks independent random destinations, with
 * a roaming radius (`wander`) that shrinks as the crew converges. React renders the node set
 * when the view model changes; positions, radii, and opacity update imperatively every frame, so
 * twenty-odd nodes stay at 60 fps on a phone.
 *
 * Visual components (BubbleNode, VenueOrb, DoerBubble) draw at a unit radius and
 * are scaled per frame, so a glass restyle only touches their markup.
 */
import type { BubblePageStatus, DoerKind, DoerState } from '@bubbleworks/shared';
import { forceSimulation, type Force, type Simulation, type SimulationNodeDatum } from 'd3-force';
import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import {
  computeLayout,
  CREW,
  floatingWindows,
  safeArea,
  type Layout,
  type Size,
  type Target,
} from './layout';
import { avoidRects, clearOf, separate, steer, type Body, type Rect } from './physics';
import { STATUS_LABEL, type Phase, type ViewModel } from './view-model';
import {
  createDrift,
  driftTarget,
  finaleFrame,
  randomPoint,
  seededRandom,
  softenVelocity,
  type Drift,
  type Random,
} from './motion';

interface Node extends SimulationNodeDatum, Body {
  kind: 'bubble' | 'venue' | 'doer' | 'crew';
  /** Target centre and float radius from the layout. */
  bx: number;
  by: number;
  wander: number;
  /** Current and target radius and opacity, eased per frame. */
  r: number;
  rt: number;
  op: number;
  opt: number;
  /** Each bubble chooses new directions on its own irregular clock. */
  drift: Drift;
  /** When it appeared, and its place in its group (doers split off in this order). */
  bornAt: number;
  order: number;
  /** The node this one flies into (the crew bubble or the venue), and when it takes off. */
  absorbInto?: string;
  absorbAt?: number;
  /** Where it waits until take-off, and its radius before shrinking. */
  hx?: number;
  hy?: number;
  rBase?: number;
  absorbed?: boolean;
  /** Something is being absorbed into it (the venue during the finale). */
  swallowing?: boolean;
  /** Crew bubble: who it takes in, and its full radius once everyone is inside. */
  members?: string[];
  rFull?: number;
  /** Doer: when it splits off the crew bubble; hidden inside it until then. */
  appearAt?: number;
  /** Ruled out or finished: its place in the pop queue, when it pops, and whether it has. */
  pop?: number;
  popAt?: number;
  popped?: boolean;
}

/** Stagger between bubbles taking off into the destination, and the pause before the first. */
const ABSORB_FIRST_MS = 700;
const ABSORB_STAGGER_MS = 420;
const ABSORB_GIVE_UP_MS = 2600;
/** Doers split off the crew bubble once everyone is inside it, one after another. */
const DOER_FIRST_MS = 350;
const DOER_STAGGER_MS = 380;
/** A doer stays up at least this long before it pops, so every step reads. */
const DOER_MIN_MS = 1400;
/** Ruled-out places pop one after another, and never before they have been seen. */
const POP_STAGGER_MS = 170;
const POP_MIN_MS = 700;
/** Length of one pop: a ring and droplets flying off. */
const POP_MS = 480;
const POP_POOL = 6;
/** Collision radius per orb, as a multiple of its radius, so labels get room too. */
const BODY: Record<Node['kind'], number> = { bubble: 1.2, venue: 1.42, doer: 1.28, crew: 1.15 };

const STATUS_HUE: Record<BubblePageStatus, string> = {
  fits: 'fits',
  stretching: 'stretch',
  holding_firm: 'firm',
  represented: 'rep',
};

const DOER_HUE: Record<DoerState, string> = {
  started: 'work',
  working: 'work',
  done: 'done',
  failed: 'fail',
  needs_human: 'stretch',
};

const DOER_NAME: Record<DoerKind, string> = {
  caller: 'Caller',
  inviter: 'Inviter',
  splitter: 'Splitter',
  watcher: 'Watcher',
};

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

function useViewport(): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
}

/** Hues per orb kind: highlight, body, and edge. */
const HUES: Record<string, [string, string, string]> = {
  fits: ['#e2f8ff', '#5cc9f3', '#1576c4'],
  crew: ['#effcff', '#66d6f6', '#1a6fc0'],
  stretch: ['#fff4d8', '#f6b74e', '#c06d0e'],
  firm: ['#ffe3dc', '#f07c69', '#b0392b'],
  rep: ['#f0e9ff', '#a996ee', '#5b45b6'],
  venue: ['#e4fff7', '#47d3b1', '#0e8a70'],
  leader: ['#f4ffd9', '#9fe45c', '#2c9632'],
  work: ['#e2f8ff', '#5cc9f3', '#1576c4'],
  done: ['#e6ffea', '#52d38b', '#16894b'],
  fail: ['#ffe2df', '#ee6b62', '#a72821'],
  idle: ['#f5f9fc', '#c4d4df', '#7c92a3'],
};

/**
 * Soap-bubble shading shared by every orb: a clear centre tinted toward the edge, light pooling
 * at the bottom, a thin-film rainbow rim, and a glossy cap with a bright highlight.
 */
function GlassDefs() {
  return (
    <defs>
      {Object.entries(HUES).map(([k, [hi, mid, lo]]) => (
        <g key={k}>
          <radialGradient id={`g-${k}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={hi} stopOpacity="0.12" />
            <stop offset="55%" stopColor={mid} stopOpacity="0.2" />
            <stop offset="80%" stopColor={mid} stopOpacity="0.46" />
            <stop offset="94%" stopColor={lo} stopOpacity="0.72" />
            <stop offset="100%" stopColor={hi} stopOpacity="0.95" />
          </radialGradient>
          <radialGradient id={`g-pool-${k}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={hi} stopOpacity="0.8" />
            <stop offset="100%" stopColor={hi} stopOpacity="0" />
          </radialGradient>
        </g>
      ))}
      <linearGradient id="g-film" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#9ff7ff" />
        <stop offset="28%" stopColor="#d2ff8c" />
        <stop offset="50%" stopColor="#fff2a6" />
        <stop offset="72%" stopColor="#ffb6ee" />
        <stop offset="100%" stopColor="#9fd8ff" />
      </linearGradient>
      <linearGradient id="g-cap" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#fff" stopOpacity="0.9" />
        <stop offset="100%" stopColor="#fff" stopOpacity="0.04" />
      </linearGradient>
      <radialGradient id="g-check" cx="50%" cy="70%" r="65%">
        <stop offset="0%" stopColor="#b8f58a" />
        <stop offset="55%" stopColor="#3dbb4c" />
        <stop offset="100%" stopColor="#1b7a2c" />
      </radialGradient>
      <radialGradient id="g-halo" cx="50%" cy="50%" r="50%">
        <stop offset="55%" stopColor="#d8ff8a" stopOpacity="0.5" />
        <stop offset="100%" stopColor="#d8ff8a" stopOpacity="0" />
      </radialGradient>
    </defs>
  );
}

/** A glass orb drawn at radius 1; the parent scales it to the node's radius. */
function Orb({ hue }: { hue: string }) {
  return (
    <>
      <circle r={1.04} fill="#03202e" opacity={0.14} cy={0.06} />
      <circle r={1} fill={`url(#g-${hue})`} />
      <ellipse cy={0.5} rx={0.62} ry={0.36} fill={`url(#g-pool-${hue})`} />
      <circle r={0.955} fill="none" stroke="url(#g-film)" strokeWidth={0.07} opacity={0.6} />
      <ellipse cy={-0.5} rx={0.68} ry={0.4} fill="url(#g-cap)" />
      <ellipse
        cx={-0.42}
        cy={-0.44}
        rx={0.15}
        ry={0.08}
        fill="#fff"
        opacity={0.95}
        transform="rotate(-40 -0.42 -0.44)"
      />
      <circle r={1} fill="none" stroke="#fff" strokeOpacity={0.85} strokeWidth={0.03} />
    </>
  );
}

/** Four-point sparkle at radius 1.6, for the finale burst. */
const SPARK =
  'M0 -1.6C0.15 -0.3 0.3 -0.15 1.6 0C0.3 0.15 0.15 0.3 0 1.6C-0.15 0.3 -0.3 0.15 -1.6 0C-0.3 -0.15 -0.15 -0.3 0 -1.6Z';

/** Fork and knife, so a venue never reads as a person. */
function Cutlery() {
  return (
    <g
      fill="none"
      stroke="#fff"
      strokeWidth={0.075}
      strokeLinecap="round"
      opacity={0.92}
      transform="translate(0 -0.02)"
    >
      <path d="M -0.3 -0.4 V -0.18 M -0.2 -0.4 V -0.18 M -0.1 -0.4 V -0.18 M -0.3 -0.18 Q -0.3 -0.06 -0.2 -0.06 Q -0.1 -0.06 -0.1 -0.18 M -0.2 -0.06 V 0.38" />
      <path d="M 0.16 0.38 V -0.4 C 0.32 -0.28 0.32 -0.04 0.16 0" />
    </g>
  );
}

export function BubbleNode({
  name,
  status,
  pulse,
  inside,
}: {
  name: string;
  status: BubblePageStatus;
  pulse: boolean;
  /** Packed inside the consensus bubble: name only. */
  inside: boolean;
}) {
  return (
    <g className={pulse ? 'pulse' : undefined}>
      <Orb hue={STATUS_HUE[status]} />
      <text className="orb-name" y={0.12} fontSize={0.42}>
        {clip(name, 8)}
      </text>
      {!inside && (
        <text className="orb-sub" y={1.45} fontSize={0.3}>
          {STATUS_LABEL[status]}
        </text>
      )}
    </g>
  );
}

/** A venue orb. Its glyph and labels hide once the finale inflates it (the arena adds `.finale`). */
export function VenueOrb({
  name,
  cuisine,
  leader,
}: {
  name: string;
  cuisine: string;
  leader: boolean;
}) {
  return (
    <g>
      {leader && <circle r={1.5} fill="url(#g-halo)" />}
      <Orb hue={leader ? 'leader' : 'venue'} />
      <g className="venue-marks">
        <Cutlery />
        <text className="orb-label" y={1.52} fontSize={0.3}>
          {clip(name, 18)}
        </text>
        <text className="orb-sub" y={1.86} fontSize={0.24}>
          {cuisine}
        </text>
      </g>
    </g>
  );
}

/** Most names the crew bubble lists before it shows "+N more". */
const CREW_LINES = 5;

/**
 * The one bubble the crew becomes once the place is decided. Each name starts hidden and fades
 * in as that person's bubble is absorbed (the arena reveals it by `data-member`).
 */
export function CrewBubble({ names }: { names: { id: string; name: string }[] }) {
  const listed = names.length > CREW_LINES ? names.slice(0, CREW_LINES - 1) : names;
  const more = names.length - listed.length;
  const lines = listed.length + (more ? 1 : 0);
  const gap = Math.min(0.3, 1.2 / Math.max(lines, 1));
  const top = (-(lines - 1) * gap) / 2;
  return (
    <g>
      <Orb hue="crew" />
      {listed.map((n, i) => (
        <text
          key={n.id}
          className="orb-name crew-name"
          data-member={n.id}
          y={top + i * gap}
          fontSize={gap * 0.78}
          style={{ opacity: 0 }}
        >
          {clip(n.name, 10)}
        </text>
      ))}
      {more > 0 && (
        <text
          className="orb-name crew-name"
          data-more=""
          y={top + listed.length * gap}
          fontSize={gap * 0.62}
          style={{ opacity: 0 }}
        >
          +{more} more
        </text>
      )}
      <text className="orb-sub" y={1.28} fontSize={0.2}>
        Your crew
      </text>
    </g>
  );
}

export function DoerBubble({
  kind,
  state,
  detail,
}: {
  kind: DoerKind;
  state: DoerState | null;
  detail: string | null;
}) {
  return (
    <g>
      <g className={state === 'started' || state === 'working' ? 'pulse' : undefined}>
        <Orb hue={state ? DOER_HUE[state] : 'idle'} />
        <text className="orb-name" y={0.1} fontSize={0.32}>
          {DOER_NAME[kind]}
        </text>
      </g>
      <text className="orb-sub" y={1.42} fontSize={0.26}>
        {clip(detail ?? (state ? state.replace('_', ' ') : 'waiting'), 26)}
      </text>
    </g>
  );
}

function syncNode(
  map: Map<string, Node>,
  id: string,
  kind: Node['kind'],
  t: Target,
  spawn: { x: number; y: number },
  random: Random,
  order = 0,
): Node {
  const now = performance.now();
  const n =
    map.get(id) ??
    ({
      id,
      kind,
      x: spawn.x,
      y: spawn.y,
      tx: spawn.x,
      ty: spawn.y,
      r: t.r * 0.4,
      op: 0,
      body: 0,
      mass: 1,
      bornAt: now,
      drift: createDrift(random),
    } as Node);
  n.bx = t.x;
  n.by = t.y;
  n.wander = t.wander;
  n.rt = t.r;
  n.opt = t.opacity;
  n.order = order;
  if (t.absorb) {
    const into = t.absorb.into;
    if (n.absorbInto !== into) {
      n.absorbInto = into;
      n.absorbAt = now + ABSORB_FIRST_MS + t.absorb.order * ABSORB_STAGGER_MS;
      n.hx = n.x ?? t.x;
      n.hy = n.y ?? t.y;
      n.rBase = t.r;
      n.absorbed = false;
    }
  } else {
    n.absorbInto = undefined;
    n.absorbAt = undefined;
  }
  if (t.pop !== undefined) {
    if (n.pop === undefined) n.pop = t.pop;
  } else {
    n.pop = n.popAt = undefined;
    n.popped = false;
  }
  return n;
}

/** Show a person's name inside the crew bubble once their bubble lands in it. */
function revealName(crew: SVGGElement | undefined, memberId: string) {
  const name =
    crew?.querySelector<SVGTextElement>(`[data-member="${CSS.escape(memberId)}"]`) ??
    crew?.querySelector<SVGTextElement>('[data-more]');
  if (name) name.style.opacity = '1';
}

/**
 * Spring toward each node's target, read fresh every tick. d3's forceX/forceY cache their
 * targets at initialization, which would freeze the floating orbits.
 */
function seek(): Force<Node, undefined> {
  let nodes: Node[] = [];
  const force = () => {
    for (const n of nodes) {
      const k = n.absorbInto ? 0.005 : 0.002;
      n.vx = (n.vx ?? 0) + (n.tx - n.x!) * k;
      n.vy = (n.vy ?? 0) + (n.ty - n.y!) * k;
    }
  };
  force.initialize = (ns: Node[]) => {
    nodes = ns;
  };
  return force;
}

/**
 * Collisions, steering around each other, and sliding around the windows. A bubble flying into
 * its destination passes behind windows (they sit above the arena) so none can strand it.
 */
function physics(windows: () => Rect[]): Force<Node, undefined> {
  let nodes: Node[] = [];
  const force = () => {
    steer(nodes);
    separate(nodes);
    avoidRects(
      nodes.filter((n) => !n.into),
      windows(),
    );
  };
  force.initialize = (ns: Node[]) => {
    nodes = ns;
  };
  return force;
}

interface Pop {
  x: number;
  y: number;
  r: number;
  at: number;
}

export function Arena({
  vm,
  phase,
  windows,
  settled: settledRef,
}: {
  vm: ViewModel;
  phase: Phase;
  /** Window rectangles on screen, in page pixels; bubbles keep out of them. */
  windows?: MutableRefObject<Rect[]>;
  /** Set to a check the feed calls before the next event: has every animation finished? */
  settled?: MutableRefObject<(() => boolean) | null>;
}) {
  const size = useViewport();
  const reduced = useReducedMotion();
  const [seed] = useState(() => Math.floor(Math.random() * 4294967296));
  const random = useRef(seededRandom(seed));
  const layout: Layout | null = useMemo(
    () => (size ? computeLayout(vm, phase, size, seed) : null),
    [vm, phase, size, seed],
  );

  const nodes = useRef(new Map<string, Node>());
  const els = useRef(new Map<string, SVGGElement>());
  const burstEl = useRef<SVGGElement | null>(null);
  const successEl = useRef<SVGGElement | null>(null);
  const popsEl = useRef<SVGGElement | null>(null);
  const pops = useRef<(Pop | null)[]>(Array.from({ length: POP_POOL }, () => null));
  const scene = useRef({ phase, size, reduced });
  const finale = useRef<{ elapsed: number; initial: number; x: number; y: number } | null>(null);
  const layoutRef = useRef<Layout | null>(null);
  const changedAt = useRef(0);
  const sim = useRef<Simulation<Node, undefined> | null>(null);

  // One simulation for the page's lifetime; it idles warm so things keep floating.
  useEffect(() => {
    let moving: Node[] = [];
    const soften: Force<Node, undefined> = () => {
      for (const node of moving) softenVelocity(node, !!node.absorbInto);
    };
    soften.initialize = (ns) => {
      moving = ns;
    };
    const rects = () => windows?.current ?? [];
    let previousTick = performance.now();
    let completeSince: number | null = null;
    const popAt = (n: Node, now: number) => {
      const slot = pops.current.findIndex((p) => !p || now - p.at >= POP_MS);
      pops.current[slot === -1 ? 0 : slot] = { x: n.x!, y: n.y!, r: n.r, at: now };
      n.popped = true;
      n.op = n.opt = 0;
    };
    const s = forceSimulation<Node>([])
      .alphaDecay(0.01)
      .alphaTarget(0.12)
      .velocityDecay(0.25)
      .force('seek', seek())
      .force('soften', soften)
      .force('physics', physics(rects))
      .on('tick', () => {
        const now = performance.now();
        const all = nodes.current;
        const crew = all.get(CREW);
        const crewWhole = !crew || !!crew.members?.every((id) => all.get(id)?.absorbed);
        const doers = [...all.values()].filter((n) => n.kind === 'doer');
        const doersOut = doers.every((d) => d.appearAt !== undefined && now >= d.appearAt);
        const doersOutAt = Math.max(0, ...doers.map((d) => d.appearAt ?? Infinity));

        for (const n of s.nodes()) {
          const viewport = scene.current.size;
          const radius = n.r + 8;
          const area = viewport ? safeArea(viewport, !!layoutRef.current?.doerOrigin) : null;
          const minY = area ? area.top - 10 : 0;
          const maxY = area ? Math.max(minY + radius, area.bottom + 5 - radius) : n.by;
          const destination = driftTarget(
            n.drift,
            now,
            {
              left: Math.max((area?.left ?? 0) + radius, n.bx - n.wander),
              right: Math.min((area?.right ?? n.bx) - radius, n.bx + n.wander),
              top: Math.max(minY + radius, n.by - n.wander),
              bottom: Math.min(maxY, n.by + n.wander),
            },
            random.current,
          );
          n.tx = scene.current.reduced ? n.bx : destination.x;
          n.ty = scene.current.reduced ? n.by : destination.y;
          if (n.opt === 0 && !n.absorbInto && n.pop === undefined) {
            n.tx = n.bx;
            n.ty = n.by;
          }
          let hidden = false;
          if (n.kind === 'crew' && n.members?.length) {
            // The crew bubble grows with each person it takes in.
            const inside = n.members.filter((id) => all.get(id)?.absorbed).length;
            n.swallowing = inside < n.members.length;
            if (!n.absorbInto) n.rt = n.rFull! * (0.45 + 0.55 * (inside / n.members.length));
            else if (
              n.absorbAt !== undefined &&
              !(crewWhole && doersOut && now >= doersOutAt + 600)
            ) {
              // Booked: head for the venue only once the crew is whole and its doers are out.
              n.absorbAt = Math.max(n.absorbAt, now + 300);
            }
          }
          if (n.kind === 'doer' && !n.popped) {
            // Doers wait inside the crew bubble until everyone is in, then split off one by one.
            if (n.appearAt === undefined && crewWhole) {
              n.appearAt = now + DOER_FIRST_MS + n.order * DOER_STAGGER_MS;
            }
            if (n.appearAt === undefined || now < n.appearAt) {
              const from = crew && !crew.absorbed ? crew : { x: n.bx, y: n.by };
              n.x = n.tx = from.x!;
              n.y = n.ty = from.y!;
              n.vx = n.vy = 0;
              n.op = 0;
              n.r = n.rt * 0.3;
              hidden = true;
            }
          }
          if (!hidden && n.pop !== undefined && !n.popped) {
            // Finished or ruled out: stay up long enough to read, then pop in turn.
            const shown =
              n.kind === 'doer' ? (n.appearAt ?? now) + DOER_MIN_MS : n.bornAt + POP_MIN_MS;
            n.popAt ??= Math.max(now + n.pop * POP_STAGGER_MS, shown);
            if (now >= n.popAt) popAt(n, now);
            else {
              n.opt = 1;
              n.tx = n.x!;
              n.ty = n.y!;
            }
          }
          const into = n.absorbInto ? all.get(n.absorbInto) : undefined;
          if (!hidden && into && n.absorbAt !== undefined) {
            if (now < n.absorbAt) {
              // Wait near its own gathering position for its turn.
              n.tx = n.hx!;
              n.ty = n.hy!;
            } else if (n.absorbed) {
              // Inside: ride along with it, hidden.
              n.x = n.tx = into.x!;
              n.y = n.ty = into.y!;
              n.vx = 0;
              n.vy = 0;
              n.opt = 0;
              n.op = 0;
            } else {
              // Pulled into the destination: shrink and fade as it gets close.
              n.tx = into.x!;
              n.ty = into.y!;
              const d = Math.hypot(n.x! - into.x!, n.y! - into.y!);
              const near = Math.min(1, Math.max(0, (d - into.r * 0.3) / (into.r * 1.6)));
              n.opt = near;
              n.rt = n.rBase! * (0.3 + 0.7 * near);
              // Close enough, or flying long enough that something must be in the way.
              if (near < 0.08 || now - n.absorbAt > ABSORB_GIVE_UP_MS) {
                // Gulp: the destination swells a little with each bubble it takes in.
                n.absorbed = true;
                into.r += into.rt * 0.12;
                if (into.kind === 'crew') revealName(els.current.get(into.id), n.id);
              }
            }
          }
          if (!hidden && !n.absorbInto) {
            const clear = clearOf(n.tx, n.ty, n.r * BODY[n.kind], rects());
            n.tx = clear.x;
            n.ty = clear.y;
          }
          if (area && viewport && !n.absorbInto && !n.swallowing && n.opt > 0) {
            // Collisions can shove an orb past the edge or under a docked window; hold it in.
            const m = n.r + 4;
            const top = area.top - 6 + n.r;
            if (n.x! < area.left + m || n.x! > area.right - m) {
              n.x = Math.min(area.right - m, Math.max(area.left + m, n.x!));
              n.vx = 0;
            }
            if (n.y! < top) {
              n.y = top;
              n.vy = 0;
            } else if (n.y! > area.bottom - n.r * BODY[n.kind]) {
              // Labels hang below the orb; keep them clear of the taskbar too.
              n.y = area.bottom - n.r * BODY[n.kind];
              n.vy = 0;
            }
          }
          n.r += (n.rt - n.r) * 0.06;
          n.op += (n.opt - n.op) * 0.05;
          // What the physics sees next tick: hidden and fading bubbles don't collide, and a
          // bubble passes through the one it is being absorbed into.
          n.body = hidden || n.popped || n.absorbed || n.opt === 0 ? 0 : n.r * BODY[n.kind] + 4;
          n.mass = n.r * n.r * (n.kind === 'venue' || n.kind === 'crew' ? 3 : 1);
          n.into = n.absorbInto && !n.absorbed ? n.absorbInto : undefined;
          const el = els.current.get(n.id);
          if (el) {
            el.setAttribute(
              'transform',
              `translate(${n.x!.toFixed(1)} ${n.y!.toFixed(1)}) scale(${n.r.toFixed(2)})`,
            );
            el.style.opacity = (n.popped ? 0 : n.op).toFixed(3);
          }
        }

        // Pops: a ring and droplets flying off where a bubble burst.
        const popGroups = popsEl.current?.children;
        pops.current.forEach((p, i) => {
          const g = popGroups?.[i] as SVGGElement | undefined;
          if (!g) return;
          const t = p ? (now - p.at) / POP_MS : 1;
          if (!p || t >= 1) {
            if (g.style.opacity !== '0') g.style.opacity = '0';
            return;
          }
          g.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
          g.style.opacity = (1 - t * t).toFixed(3);
          const [ring, ...drops] = Array.from(g.children);
          ring?.setAttribute('r', (p.r * (1 + 0.45 * t)).toFixed(1));
          drops.forEach((drop, j) => {
            const angle = (j / drops.length) * Math.PI * 2 + (j % 3) * 0.3;
            const dist = p.r * (0.8 + 0.9 * t + (j % 2) * 0.15);
            drop.setAttribute('cx', (Math.cos(angle) * dist).toFixed(1));
            drop.setAttribute('cy', (Math.sin(angle) * dist).toFixed(1));
            drop.setAttribute('r', (p.r * 0.1 * (1 - 0.7 * t)).toFixed(2));
          });
        });

        // Once complete, and every doer has popped or gone in, the one-shot inflate-and-pop.
        const current = scene.current;
        const step = Math.min(50, now - previousTick);
        previousTick = now;
        if (current.phase !== 'complete') {
          completeSince = null;
          finale.current = null;
          if (burstEl.current) burstEl.current.style.opacity = '0';
          if (successEl.current) successEl.current.style.opacity = '0';
          return;
        }
        completeSince ??= now;
        const winner = s.nodes().find((n) => n.kind === 'venue' && n.swallowing);
        if (!winner || !current.size) return;
        const gathering = s.nodes().filter((n) => n.absorbInto === winner.id);
        const doersGone = doers.every((d) => d.popped || d.absorbed);
        const popping = pops.current.some((p) => p && now - p.at < POP_MS);
        if (
          !finale.current &&
          (current.reduced ||
            (gathering.every((n) => n.absorbed) && doersGone && !popping) ||
            now - completeSince > 12000)
        ) {
          finale.current = { elapsed: 0, initial: winner.r, x: winner.x!, y: winner.y! };
          els.current.get(winner.id)?.classList.add('finale');
        }
        const ending = finale.current;
        if (!ending) return;
        ending.elapsed += step;
        // The finale sits centred in the space between the windows.
        const room = safeArea(current.size, true);
        const centreY = room.top + room.height / 2;
        ending.x += (room.left + room.width / 2 - ending.x) * 0.035;
        ending.y += (centreY - ending.y) * 0.035;
        const maxRadius = Math.max(
          40,
          Math.min(
            room.width * 0.37,
            room.height * 0.46,
            floatingWindows(current.size) ? 260 : 190,
          ),
        );
        const frame = finaleFrame(
          ending.elapsed,
          Math.min(ending.initial, maxRadius * 0.65),
          maxRadius,
          current.reduced,
        );
        const hero = els.current.get(winner.id);
        if (hero) {
          hero.setAttribute(
            'transform',
            `translate(${ending.x} ${ending.y}) scale(${frame.radius})`,
          );
          hero.style.opacity = String(frame.bubbleOpacity);
        }
        for (const member of gathering) {
          member.op = 0;
          member.opt = 0;
          const el = els.current.get(member.id);
          if (el) el.style.opacity = '0';
        }
        const burst = burstEl.current;
        if (burst) {
          burst.setAttribute('transform', `translate(${ending.x} ${ending.y})`);
          burst.style.opacity = String(frame.burstOpacity);
          Array.from(burst.children).forEach((particle, i) => {
            const angle = (i / 18) * Math.PI * 2 + (i % 3) * 0.14;
            const distance = maxRadius * (0.65 + frame.burstProgress * (0.65 + (i % 4) * 0.12));
            particle.setAttribute(
              'transform',
              `translate(${Math.cos(angle) * distance} ${Math.sin(angle) * distance}) scale(${(1 - frame.burstProgress * 0.8) * (3 + (i % 4))})`,
            );
          });
        }
        const success = successEl.current;
        if (success) {
          success.setAttribute('transform', `translate(${ending.x} ${ending.y})`);
          success.style.opacity = String(frame.successOpacity);
        }
      });
    sim.current = s;
    const onVisible = () => {
      previousTick = performance.now();
      if (document.hidden || scene.current.reduced) s.stop();
      else s.restart();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      s.stop();
    };
  }, [windows]);

  // The feed waits on this before the next event, so no step starts before the last one ends.
  useEffect(() => {
    if (!settledRef) return;
    settledRef.current = () => {
      if (scene.current.reduced) return true;
      const now = performance.now();
      if (now - changedAt.current < 300) return false;
      for (const n of nodes.current.values()) {
        if (n.absorbInto && !n.absorbed) return false;
        if (n.kind === 'doer' && !n.popped && (n.appearAt === undefined || now < n.appearAt + 500))
          return false;
        if (n.pop !== undefined && !n.popped) return false;
      }
      if (pops.current.some((p) => p && now - p.at < POP_MS)) return false;
      if (scene.current.phase === 'complete' && (finale.current?.elapsed ?? 0) < 3300) return false;
      return true;
    };
    return () => {
      settledRef.current = null;
    };
  }, [settledRef]);

  // New layout: retarget nodes, add and drop nodes, kick the simulation.
  useEffect(() => {
    const s = sim.current;
    if (!s || !layout || !size) return;
    layoutRef.current = layout;
    scene.current = { phase, size, reduced };
    changedAt.current = performance.now();
    const next = new Map<string, Node>();
    const spawn = (t: Target) =>
      randomPoint({ left: t.x - 8, right: t.x + 8, top: t.y - 8, bottom: t.y + 8 }, random.current);
    for (const [id, t] of Object.entries(layout.venues)) {
      next.set(`v:${id}`, syncNode(nodes.current, `v:${id}`, 'venue', t, spawn(t), random.current));
    }
    for (const [id, t] of Object.entries(layout.bubbles)) {
      next.set(id, syncNode(nodes.current, id, 'bubble', t, spawn(t), random.current));
    }
    Object.entries(layout.doers).forEach(([kind, t], i) => {
      next.set(
        `d:${kind}`,
        syncNode(nodes.current, `d:${kind}`, 'doer', t, spawn(t), random.current, i),
      );
    });
    if (layout.crew) {
      const crew = syncNode(
        nodes.current,
        CREW,
        'crew',
        layout.crew,
        spawn(layout.crew),
        random.current,
      );
      crew.members = layout.crew.members;
      crew.rFull = layout.crew.r;
      next.set(CREW, crew);
    }
    // The destination of whatever is being absorbed; the finale inflates it.
    const swallowers = new Set(
      [
        ...Object.values(layout.bubbles),
        ...Object.values(layout.doers),
        ...(layout.crew ? [layout.crew] : []),
      ].flatMap((t) => (t.absorb ? [t.absorb.into] : [])),
    );
    for (const n of next.values()) n.swallowing = swallowers.has(n.id);
    nodes.current = next;
    const list = [...next.values()];
    if (reduced) {
      s.stop();
      const now = performance.now();
      for (const n of list) {
        n.wander = 0;
        n.x = n.bx;
        n.y = n.by;
        n.r = n.rt;
        n.op = n.absorbInto || n.pop !== undefined ? 0 : n.opt;
        if (n.absorbInto) {
          n.opt = 0;
          n.absorbed = true;
        }
        if (n.pop !== undefined) n.popped = true;
        if (n.kind === 'doer') n.appearAt = now - DOER_FIRST_MS;
      }
      for (const id of layout.crew?.members ?? []) revealName(els.current.get(CREW), id);
      s.nodes(list);
      // Settle collisions without animating, then draw once at rest.
      s.tick(40);
      s.on('tick')?.call(s);
    } else {
      s.nodes(list);
      s.alpha(Math.max(s.alpha(), 0.15)).restart();
    }
  }, [layout, size, reduced, phase]);

  if (!size || !layout) return <svg className="arena" />;

  const settled = phase === 'locked' || phase === 'summary' || phase === 'complete';
  const reg = (id: string) => (el: SVGGElement | null) => {
    if (el) els.current.set(id, el);
    else els.current.delete(id);
  };
  const group = (id: string, children: ReactNode) => (
    <g key={id} ref={reg(id)} style={{ opacity: 0 }}>
      {children}
    </g>
  );

  return (
    <svg
      className="arena"
      width={size.w}
      height={size.h}
      viewBox={`0 0 ${size.w} ${size.h}`}
      role="img"
      aria-label={
        phase === 'complete' ? 'Success! Your dinner plan is ready.' : 'Bubbles deliberating'
      }
    >
      <GlassDefs />
      {vm.venues.map((v) =>
        layout.venues[v.venueId]
          ? group(
              `v:${v.venueId}`,
              <VenueOrb
                name={v.name}
                cuisine={v.cuisine}
                leader={layout.venues[v.venueId]!.leader}
              />,
            )
          : null,
      )}
      {vm.bubbles.map((b) =>
        layout.bubbles[b.userId]
          ? group(
              b.userId,
              <BubbleNode
                name={b.displayName}
                status={b.status}
                pulse={
                  phase === 'deadlock' && (b.status === 'stretching' || b.status === 'holding_firm')
                }
                inside={layout.consensus?.members.includes(b.userId) ?? false}
              />,
            )
          : null,
      )}
      {layout.crew &&
        group(
          CREW,
          <CrewBubble
            names={layout.crew.members.map((id) => ({
              id,
              name: vm.bubbles.find((b) => b.userId === id)?.displayName ?? '',
            }))}
          />,
        )}
      {settled &&
        (Object.keys(layout.doers) as DoerKind[]).map((kind) =>
          group(
            `d:${kind}`,
            <DoerBubble
              kind={kind}
              state={vm.doers[kind]?.state ?? null}
              detail={vm.doers[kind]?.detail ?? null}
            />,
          ),
        )}
      <g ref={popsEl} aria-hidden="true">
        {Array.from({ length: POP_POOL }, (_, i) => (
          <g key={i} style={{ opacity: 0 }}>
            <circle r={1} fill="none" stroke="#fff" strokeWidth={2} strokeOpacity={0.85} />
            {Array.from({ length: 10 }, (_, j) => (
              <circle key={j} r={1} fill={j % 2 ? '#e6fdff' : '#dcffa8'} />
            ))}
          </g>
        ))}
      </g>
      <g ref={burstEl} style={{ opacity: 0 }} aria-hidden="true">
        {Array.from({ length: 18 }, (_, i) =>
          i % 3 === 0 ? (
            <g key={i}>
              <path d={SPARK} fill="#e4ff9c" />
            </g>
          ) : (
            <g key={i}>
              <circle r={1} fill="url(#g-fits)" stroke="#fff" strokeWidth={0.14} />
              <circle cx={-0.35} cy={-0.35} r={0.22} fill="#fff" />
            </g>
          ),
        )}
      </g>
      <g ref={successEl} style={{ opacity: 0 }} aria-hidden="true">
        <circle cy={-42} r={25} fill="url(#g-check)" stroke="#11622a" strokeWidth={1} />
        <ellipse cy={-53} rx={18} ry={10} fill="url(#g-cap)" />
        <path
          d="M -11 -42 L -3 -33 L 12 -51"
          fill="none"
          stroke="#fff"
          strokeWidth={5.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <text className="success-title" y={12}>
          Success!
        </text>
        <text className="success-sub" y={43}>
          See you there.
        </text>
      </g>
    </svg>
  );
}
