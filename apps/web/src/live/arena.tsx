'use client';

/**
 * Full-screen deliberation arena. Every bubble, venue orb, and doer is a node in one d3-force
 * simulation that never fully cools: each node floats around its layout target on its own slow
 * orbit, with a radius (`wander`) that shrinks as the crew converges. React renders the node set
 * when the view model changes; positions, radii, and opacity update imperatively every frame, so
 * twenty-odd nodes stay at 60 fps on a phone.
 *
 * Visual components (BubbleNode, VenueOrb, ConsensusBubble, DoerBubble) draw at a unit radius and
 * are scaled per frame, so a glass restyle only touches their markup.
 */
import type { BubblePageStatus, DoerKind, DoerState } from '@bubbleworks/shared';
import {
  forceCollide,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { computeLayout, type Layout, type Size, type Target } from './layout';
import { STATUS_LABEL, type Phase, type ViewModel } from './view-model';

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
  /** Per-node orbit, so nothing floats in lockstep. */
  fx1: number;
  fy1: number;
  px: number;
  py: number;
  tx: number;
  ty: number;
}

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

function hash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
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

/** Glass shading shared by every orb: body gradient per hue, rim, specular highlight. */
function GlassDefs() {
  const hues: Record<string, [string, string, string]> = {
    fits: ['#c9ecff', '#43a9f0', '#1468b8'],
    stretch: ['#ffe9c2', '#f5ad45', '#c06a10'],
    firm: ['#ffd4cc', '#ec6d5e', '#a8322a'],
    rep: ['#e6dcff', '#9e8be6', '#5a45b0'],
    venue: ['#d2fff1', '#3ccaa6', '#0e7f6a'],
    leader: ['#e0ffe9', '#3bd27f', '#11804a'],
    work: ['#c9ecff', '#43a9f0', '#1468b8'],
    done: ['#dcffe8', '#36c278', '#147a45'],
    fail: ['#ffd4d2', '#e45a55', '#9b2420'],
    idle: ['#eef4f8', '#b9cad6', '#7f93a3'],
  };
  return (
    <defs>
      {Object.entries(hues).map(([k, [hi, mid, lo]]) => (
        <radialGradient key={k} id={`g-${k}`} cx="38%" cy="32%" r="75%">
          <stop offset="0%" stopColor={hi} />
          <stop offset="45%" stopColor={mid} stopOpacity="0.92" />
          <stop offset="100%" stopColor={lo} stopOpacity="0.95" />
        </radialGradient>
      ))}
      <radialGradient id="g-shine" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
        <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="g-inner" cx="50%" cy="50%" r="50%">
        <stop offset="70%" stopColor="#ffffff" stopOpacity="0" />
        <stop offset="100%" stopColor="#ffffff" stopOpacity="0.55" />
      </radialGradient>
      <radialGradient id="g-consensus" cx="45%" cy="38%" r="65%">
        <stop offset="0%" stopColor="#ffffff" stopOpacity="0.32" />
        <stop offset="80%" stopColor="#bfe8ff" stopOpacity="0.16" />
        <stop offset="100%" stopColor="#ffffff" stopOpacity="0.5" />
      </radialGradient>
      <linearGradient id="g-rim" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
        <stop offset="50%" stopColor="#9fe3ff" stopOpacity="0.6" />
        <stop offset="100%" stopColor="#c7b8ff" stopOpacity="0.8" />
      </linearGradient>
    </defs>
  );
}

/** A glass orb drawn at radius 1; the parent scales it to the node's radius. */
function Orb({ hue }: { hue: string }) {
  return (
    <>
      <circle r={1.08} fill="#0b3550" opacity={0.1} cy={0.06} />
      <circle r={1} fill={`url(#g-${hue})`} />
      <circle r={1} fill="url(#g-inner)" />
      <ellipse cx={-0.32} cy={-0.42} rx={0.46} ry={0.3} fill="url(#g-shine)" />
      <circle r={1} fill="none" stroke="url(#g-rim)" strokeWidth={0.05} />
    </>
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
}: {
  name: string;
  cuisine: string;
  leader: boolean;
}) {
  return (
    <g>
      {leader && (
        <circle r={1.16} fill="none" stroke="#3bd27f" strokeWidth={0.07} className="halo" />
      )}
      <Orb hue={leader ? 'leader' : 'venue'} />
      <text className="orb-label" y={1.52} fontSize={0.3}>
        {clip(name, 18)}
      </text>
      <text className="orb-sub" y={1.86} fontSize={0.24}>
        {cuisine}
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

/** Drawn at radius 1; positioned and scaled every frame around its members. */
export function ConsensusBubble() {
  return (
    <>
      <circle r={1} fill="url(#g-consensus)" />
      <circle r={1} fill="none" stroke="url(#g-rim)" strokeWidth={0.025} />
      <ellipse cx={-0.38} cy={-0.5} rx={0.32} ry={0.16} fill="url(#g-shine)" opacity={0.7} />
    </>
  );
}

function syncNode(
  map: Map<string, Node>,
  id: string,
  kind: Node['kind'],
  t: Target,
  spawn: { x: number; y: number },
): Node {
  const seed = hash(id);
  const n =
    map.get(id) ??
    ({
      id,
      kind,
      x: spawn.x,
      y: spawn.y,
      r: t.r * 0.4,
      op: 0,
      fx1: 0.00018 + seed * 0.00022,
      fy1: 0.00014 + ((seed * 7) % 1) * 0.0002,
      px: seed * Math.PI * 2,
      py: ((seed * 13) % 1) * Math.PI * 2,
    } as Node);
  n.bx = t.x;
  n.by = t.y;
  n.wander = t.wander;
  n.rt = t.r;
  n.opt = t.opacity;
  n.tx = t.x;
  n.ty = t.y;
  return n;
}

export function Arena({ vm, phase }: { vm: ViewModel; phase: Phase }) {
  const size = useViewport();
  const reduced = useReducedMotion();
  const layout: Layout | null = useMemo(
    () => (size ? computeLayout(vm, phase, size) : null),
    [vm, phase, size],
  );

  const nodes = useRef(new Map<string, Node>());
  const els = useRef(new Map<string, SVGGElement>());
  const consensusEl = useRef<SVGGElement | null>(null);
  const consensusState = useRef({ x: 0, y: 0, r: 0, op: 0 });
  const layoutRef = useRef<Layout | null>(null);
  const sim = useRef<Simulation<Node, undefined> | null>(null);

  // One simulation for the page's lifetime; it idles warm so things keep floating.
  useEffect(() => {
    const s = forceSimulation<Node>([])
      .alphaDecay(0.01)
      .alphaTarget(0.12)
      .velocityDecay(0.32)
      .force(
        'collide',
        // Labels need room too: venue names sit below the orb, statuses below bubbles.
        forceCollide<Node>(
          (n) => n.r * (n.kind === 'venue' ? 1.75 : n.kind === 'doer' ? 1.3 : 1.25) + 3,
        )
          .strength(0.7)
          .iterations(2),
      )
      .force('x', forceX<Node>((n) => n.tx).strength(0.045))
      .force('y', forceY<Node>((n) => n.ty).strength(0.045))
      .on('tick', () => {
        const now = performance.now();
        for (const n of s.nodes()) {
          // Each node orbits its target slowly: two sines at their own frequencies.
          n.tx = n.bx + Math.sin(now * n.fx1 + n.px) * n.wander;
          n.ty = n.by + Math.cos(now * n.fy1 + n.py) * n.wander * 0.8;
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
        // The consensus bubble wraps its members wherever they actually are.
        const c = layoutRef.current?.consensus;
        const cs = consensusState.current;
        if (c) {
          let x = 0;
          let y = 0;
          const members = c.members
            .map((id) => nodes.current.get(id))
            .filter((n): n is Node => !!n);
          for (const m of members) {
            x += m.x!;
            y += m.y!;
          }
          if (members.length) {
            x /= members.length;
            y /= members.length;
            let reach = 0;
            for (const m of members) reach = Math.max(reach, Math.hypot(m.x! - x, m.y! - y) + m.r);
            const k = cs.op < 0.01 ? 1 : 0.12;
            cs.x += (x - cs.x) * k;
            cs.y += (y - cs.y) * k;
            cs.r += (Math.max(reach + 10, c.r) - cs.r) * 0.08;
          }
          cs.op += (1 - cs.op) * 0.05;
        } else {
          cs.op += (0 - cs.op) * 0.08;
        }
        const ce = consensusEl.current;
        if (ce) {
          ce.setAttribute(
            'transform',
            `translate(${cs.x.toFixed(1)} ${cs.y.toFixed(1)}) scale(${Math.max(cs.r, 1).toFixed(1)})`,
          );
          ce.style.opacity = cs.op.toFixed(3);
        }
      });
    sim.current = s;
    const onVisible = () => (document.hidden ? s.stop() : s.restart());
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
    const next = new Map<string, Node>();
    const bottom = { x: size.w / 2, y: size.h + 60 };
    for (const [id, t] of Object.entries(layout.venues)) {
      next.set(`v:${id}`, syncNode(nodes.current, `v:${id}`, 'venue', t, { x: t.x, y: -60 }));
    }
    for (const [id, t] of Object.entries(layout.bubbles)) {
      const spawn = { x: t.x + (hash(id) - 0.5) * size.w * 0.4, y: bottom.y };
      next.set(id, syncNode(nodes.current, id, 'bubble', t, spawn));
    }
    for (const [kind, t] of Object.entries(layout.doers)) {
      const origin = layout.doerOrigin ?? { x: t.x, y: t.y };
      next.set(`d:${kind}`, syncNode(nodes.current, `d:${kind}`, 'doer', t, origin));
    }
    nodes.current = next;
    const list = [...next.values()];
    if (reduced) {
      s.stop();
      for (const n of list) {
        n.wander = 0;
        n.x = n.bx;
        n.y = n.by;
        n.r = n.rt;
        n.op = n.opt;
      }
      s.nodes(list);
      // Settle collisions without animating, then draw once at rest.
      s.tick(40);
      s.on('tick')?.call(s);
    } else {
      s.nodes(list);
      s.alpha(Math.max(s.alpha(), 0.5)).restart();
    }
  }, [layout, size, reduced]);

  if (!size || !layout) return <svg className="arena" />;

  const settled = phase === 'locked' || phase === 'summary';
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
      aria-label="Bubbles deliberating"
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
      <g ref={consensusEl} style={{ opacity: 0 }}>
        <ConsensusBubble />
      </g>
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
    </svg>
  );
}
