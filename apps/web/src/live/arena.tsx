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
import {
  forceCollide,
  forceSimulation,
  type Force,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { computeLayout, safeArea, type Layout, type Size, type Target } from './layout';
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

interface Node extends SimulationNodeDatum {
  id: string;
  kind: 'bubble' | 'venue' | 'doer';
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
  tx: number;
  ty: number;
  /** Booked: the venue node this bubble flies into, and when it takes off. */
  absorbInto?: string;
  absorbAt?: number;
  /** Where it waits until take-off, and its radius before shrinking. */
  hx?: number;
  hy?: number;
  rBase?: number;
  absorbed?: boolean;
  /** The destination while it absorbs: collisions add both radii, so it must yield too. */
  swallowing?: boolean;
}

/** Stagger between bubbles taking off into the destination, and the pause before the first. */
const ABSORB_FIRST_MS = 700;
const ABSORB_STAGGER_MS = 420;

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

export function VenueOrb({
  name,
  cuisine,
  leader,
  final,
}: {
  name: string;
  cuisine: string;
  leader: boolean;
  /** Marks the confirmed destination for the success finale. */
  final: string | null;
}) {
  return (
    <g>
      {leader && <circle r={1.5} fill="url(#g-halo)" />}
      <Orb hue={leader ? 'leader' : 'venue'} />
      {!final && (
        <>
          <Cutlery />
          <text className="orb-label" y={1.52} fontSize={0.3}>
            {clip(name, 18)}
          </text>
          <text className="orb-sub" y={1.86} fontSize={0.24}>
            {cuisine}
          </text>
        </>
      )}
      {final && (
        <text className="orb-name" y={0.06} fontSize={0.2}>
          Success!
        </text>
      )}
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
): Node {
  const n =
    map.get(id) ??
    ({
      id,
      kind,
      x: spawn.x,
      y: spawn.y,
      r: t.r * 0.4,
      op: 0,
      drift: createDrift(random),
    } as Node);
  n.bx = t.x;
  n.by = t.y;
  n.wander = t.wander;
  n.rt = t.r;
  n.opt = t.opacity;
  n.tx ??= spawn.x;
  n.ty ??= spawn.y;
  if (t.absorb) {
    const into = `v:${t.absorb.venueId}`;
    if (n.absorbInto !== into) {
      n.absorbInto = into;
      n.absorbAt = performance.now() + ABSORB_FIRST_MS + t.absorb.order * ABSORB_STAGGER_MS;
      n.hx = n.x ?? t.x;
      n.hy = n.y ?? t.y;
      n.rBase = t.r;
      n.absorbed = false;
    }
  } else {
    n.absorbInto = undefined;
    n.absorbAt = undefined;
  }
  return n;
}

/** Collision radius. Labels need room too: venue names sit below orbs, statuses below bubbles. */
function collideRadius(n: Node): number {
  // Headed into the destination, or the destination itself: no collisions, so it can swallow.
  if (n.absorbInto || n.swallowing) return 0;
  return n.r * (n.kind === 'venue' ? 1.75 : n.kind === 'doer' ? 1.3 : 1.25) + 3;
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

export function Arena({ vm, phase }: { vm: ViewModel; phase: Phase }) {
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
  const scene = useRef({ phase, size, reduced });
  const finale = useRef<{ elapsed: number; initial: number; x: number; y: number } | null>(null);
  const layoutRef = useRef<Layout | null>(null);
  const sim = useRef<Simulation<Node, undefined> | null>(null);

  // One simulation for the page's lifetime; it idles warm so things keep floating.
  useEffect(() => {
    const collide = forceCollide<Node>(collideRadius).strength(0.25).iterations(2);
    let moving: Node[] = [];
    const soften: Force<Node, undefined> = () => {
      for (const node of moving) softenVelocity(node, !!node.absorbInto);
    };
    soften.initialize = (ns) => {
      moving = ns;
    };
    let previousTick = performance.now();
    let completeSince: number | null = null;
    const s = forceSimulation<Node>([])
      .alphaDecay(0.01)
      .alphaTarget(0.12)
      .velocityDecay(0.25)
      .force('collide', collide)
      .force('seek', seek())
      .force('soften', soften)
      .on('tick', () => {
        const now = performance.now();

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
              left: Math.max(radius, n.bx - n.wander),
              right: Math.min((viewport?.w ?? n.bx) - radius, n.bx + n.wander),
              top: Math.max(minY + radius, n.by - n.wander),
              bottom: Math.min(maxY, n.by + n.wander),
            },
            random.current,
          );
          n.tx = scene.current.reduced ? n.bx : destination.x;
          n.ty = scene.current.reduced ? n.by : destination.y;
          if (n.opt === 0 && !n.absorbInto) {
            n.tx = n.bx;
            n.ty = n.by;
          }
          const into = n.absorbInto ? nodes.current.get(n.absorbInto) : undefined;
          if (into && n.absorbAt !== undefined) {
            if (now < n.absorbAt) {
              // Wait near its own gathering position for its turn.
              n.tx = n.hx!;
              n.ty = n.hy!;
            } else {
              // Pulled into the destination: shrink and fade as it gets close.
              n.tx = into.x!;
              n.ty = into.y!;
              const d = Math.hypot(n.x! - into.x!, n.y! - into.y!);
              const near = Math.min(1, Math.max(0, (d - into.r * 0.3) / (into.r * 1.6)));
              n.opt = near;
              n.rt = n.rBase! * (0.3 + 0.7 * near);
              if (!n.absorbed && near < 0.08) {
                // Gulp: the venue swells a little with each bubble it takes in.
                n.absorbed = true;
                into.r += into.rt * 0.12;
              }
            }
          }
          if (area && viewport && !n.absorbInto && !n.swallowing && n.opt > 0) {
            // Collisions can shove an orb past the edge or under the plan window; hold it in.
            const m = n.r + 4;
            const top = area.top - 6 + n.r;
            if (n.x! < m || n.x! > viewport.w - m) {
              n.x = Math.min(viewport.w - m, Math.max(m, n.x!));
              n.vx = 0;
            }
            if (n.y! < top) {
              n.y = top;
              n.vy = 0;
            }
          }
          n.r += (n.rt - n.r) * 0.06;
          n.op += (n.opt - n.op) * 0.05;
          const el = els.current.get(n.id);
          if (el) {
            el.setAttribute(
              'transform',
              `translate(${n.x!.toFixed(1)} ${n.y!.toFixed(1)}) scale(${n.r.toFixed(2)})`,
            );
            el.style.opacity = n.op.toFixed(3);
          }
        }
        // forceCollide caches radii; refresh them as nodes grow, shrink, and take off.
        collide.radius(collideRadius);
        // Let the crew finish gathering before the one-shot inflate-and-pop finale.
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
        if (
          !finale.current &&
          (current.reduced || gathering.every((n) => n.absorbed) || now - completeSince > 8000)
        ) {
          finale.current = { elapsed: 0, initial: winner.r, x: winner.x!, y: winner.y! };
        }
        const ending = finale.current;
        if (!ending) return;
        ending.elapsed += step;
        // The finale sits centred in the space between the plan window and the booking dialog.
        const room = safeArea(current.size, true);
        const centreY = room.top + room.height / 2;
        ending.x += (current.size.w / 2 - ending.x) * 0.035;
        ending.y += (centreY - ending.y) * 0.035;
        const maxRadius = Math.max(40, Math.min(current.size.w * 0.37, room.height * 0.46, 190));
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
  }, []);

  // New layout: retarget nodes, add and drop nodes, kick the simulation.
  useEffect(() => {
    const s = sim.current;
    if (!s || !layout || !size) return;
    layoutRef.current = layout;
    scene.current = { phase, size, reduced };
    const next = new Map<string, Node>();
    const spawn = (t: Target) =>
      randomPoint({ left: t.x - 8, right: t.x + 8, top: t.y - 8, bottom: t.y + 8 }, random.current);
    for (const [id, t] of Object.entries(layout.venues)) {
      next.set(`v:${id}`, syncNode(nodes.current, `v:${id}`, 'venue', t, spawn(t), random.current));
    }
    for (const [id, t] of Object.entries(layout.bubbles)) {
      next.set(id, syncNode(nodes.current, id, 'bubble', t, spawn(t), random.current));
    }
    for (const [kind, t] of Object.entries(layout.doers)) {
      const origin = spawn(t);
      next.set(
        `d:${kind}`,
        syncNode(nodes.current, `d:${kind}`, 'doer', t, origin, random.current),
      );
    }
    // Whatever is being absorbed, the destination must yield its collisions to take it in.
    const swallower = [...Object.values(layout.bubbles), ...Object.values(layout.doers)].find(
      (t) => t.absorb,
    )?.absorb?.venueId;
    for (const n of next.values()) n.swallowing = n.kind === 'venue' && n.id === `v:${swallower}`;
    nodes.current = next;
    const list = [...next.values()];
    if (reduced) {
      s.stop();
      for (const n of list) {
        n.wander = 0;
        n.x = n.bx;
        n.y = n.by;
        n.r = n.rt;
        n.op = n.absorbInto ? 0 : n.opt;
        if (n.absorbInto) n.opt = 0;
      }
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
                final={
                  phase === 'complete' && layout.venues[v.venueId]!.leader && vm.booking
                    ? `${new Date(vm.booking.startAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · table for ${vm.booking.partySize}`
                    : null
                }
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
