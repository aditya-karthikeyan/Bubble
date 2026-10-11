'use client';

/**
 * The deliberation arena, Phase 2 visuals: plain circles on an SVG, positioned by a d3-force
 * simulation toward the targets from layout.ts. Phase 3 swaps the visual components (BubbleNode,
 * VenueOrb, ConsensusBubble, DoerBubble) for the glass versions behind the same props.
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
import { useEffect, useMemo, useRef, useState } from 'react';
import { BUBBLE_R, DOER_R, H, W, computeLayout, type Layout } from './layout';
import { STATUS_LABEL, type Phase, type ViewModel } from './view-model';

interface Node extends SimulationNodeDatum {
  id: string;
  r: number;
  tx: number;
  ty: number;
}

const STATUS_FILL: Record<BubblePageStatus, string> = {
  fits: '#2f9be8',
  stretching: '#f0a43a',
  holding_firm: '#e8665a',
  represented: '#9b8be0',
};

const DOER_FILL: Record<DoerState, string> = {
  started: '#2f9be8',
  working: '#2f9be8',
  done: '#2fb37a',
  failed: '#d9534f',
  needs_human: '#f0a43a',
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

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Bubble positions from the simulation; venues are pinned, so they only collide. */
function useBubblePositions(vm: ViewModel, layout: Layout, phase: Phase, reduced: boolean) {
  const nodes = useRef(new Map<string, Node>());
  const sim = useRef<Simulation<Node, undefined> | null>(null);
  const [, setFrame] = useState(0);

  useEffect(() => {
    const s = forceSimulation<Node>([])
      .force('collide', forceCollide<Node>((n) => n.r + 3).strength(0.9))
      .force('x', forceX<Node>((n) => n.tx).strength(0.07))
      .force('y', forceY<Node>((n) => n.ty).strength(0.07))
      .alphaDecay(0.025)
      .on('tick', () => setFrame((f) => (f + 1) % 1_000_000));
    sim.current = s;
    return () => {
      s.stop();
    };
  }, []);

  useEffect(() => {
    const s = sim.current;
    if (!s) return;
    const settled = phase === 'locked' || phase === 'summary';
    const live = new Map<string, Node>();
    for (const b of vm.bubbles) {
      const target = layout.bubbles[b.userId];
      if (!target) continue;
      const existing = nodes.current.get(b.userId);
      const n: Node = existing ?? {
        id: b.userId,
        r: BUBBLE_R,
        tx: target.x,
        ty: target.y,
        x: target.x,
        y: H + 40,
      };
      n.tx = target.x;
      n.ty = target.y;
      n.r = settled && b.present ? BUBBLE_R * 0.55 : BUBBLE_R;
      live.set(b.userId, n);
    }
    for (const [id, v] of Object.entries(layout.venues)) {
      const key = `venue:${id}`;
      const n = nodes.current.get(key) ?? { id: key, r: v.r, tx: v.x, ty: v.y, x: v.x, y: v.y };
      n.fx = v.x;
      n.fy = v.y;
      n.r = v.r;
      live.set(key, n);
    }
    nodes.current = live;
    const list = [...live.values()];
    s.nodes(list);
    if (reduced) {
      s.stop();
      for (const n of list) {
        n.x = n.fx ?? n.tx;
        n.y = n.fy ?? n.ty;
      }
      setFrame((f) => f + 1);
    } else {
      s.alpha(0.7).restart();
    }
  }, [vm, layout, phase, reduced]);

  return nodes.current;
}

export function VenueOrb(props: {
  name: string;
  cuisine: string;
  x: number;
  y: number;
  r: number;
  dim: boolean;
  leader: boolean;
}) {
  const { name, cuisine, x, y, r, dim, leader } = props;
  return (
    <g className="venue" transform={`translate(${x} ${y})`} opacity={dim ? 0.3 : 1}>
      {leader && <circle r={r + 6} fill="none" stroke="#2fb37a" strokeWidth={3} />}
      <circle r={r} fill="#3fc1a5" stroke="#ffffff" strokeWidth={2} />
      <text y={r + 15} textAnchor="middle" className="label">
        {clip(name, 14)}
      </text>
      <text y={r + 28} textAnchor="middle" className="sublabel">
        {cuisine}
      </text>
    </g>
  );
}

export function BubbleNode(props: {
  name: string;
  status: BubblePageStatus;
  x: number;
  y: number;
  r: number;
  present: boolean;
  pulse: boolean;
  compact: boolean;
}) {
  const { name, status, x, y, r, present, pulse, compact } = props;
  return (
    <g transform={`translate(${x} ${y})`} opacity={present ? 1 : 0} className="bubble-node">
      <g className={pulse ? 'pulse' : 'bob'}>
        <circle
          r={r}
          fill={STATUS_FILL[status]}
          stroke="#ffffff"
          strokeWidth={2}
          strokeDasharray={status === 'represented' ? '5 4' : undefined}
        />
        <text y={compact ? 3 : 4} textAnchor="middle" className={compact ? 'name small' : 'name'}>
          {clip(name, compact ? 6 : 9)}
        </text>
        {!compact && (
          <text y={r + 13} textAnchor="middle" className="sublabel">
            {STATUS_LABEL[status]}
          </text>
        )}
      </g>
    </g>
  );
}

export function ConsensusBubble(props: { x: number; y: number; r: number }) {
  return (
    <g className="consensus" style={{ transform: `translate(${props.x}px, ${props.y}px)` }}>
      <circle r={props.r} fill="rgba(255,255,255,0.35)" stroke="#ffffff" strokeWidth={3} />
    </g>
  );
}

export function DoerBubble(props: {
  kind: DoerKind;
  state: DoerState | null;
  detail: string | null;
  x: number;
  y: number;
}) {
  const { kind, state, detail, x, y } = props;
  return (
    <g className="doer" style={{ transform: `translate(${x}px, ${y}px)` }}>
      <g className={state === 'started' || state === 'working' ? 'pulse' : undefined}>
        <circle
          r={DOER_R}
          fill={state ? DOER_FILL[state] : '#b7cad6'}
          stroke="#ffffff"
          strokeWidth={2}
        />
        <text y={4} textAnchor="middle" className="name">
          {DOER_NAME[kind]}
        </text>
      </g>
      <text y={DOER_R + 15} textAnchor="middle" className="sublabel">
        {clip(detail ?? (state ? state.replace('_', ' ') : 'waiting'), 24)}
      </text>
    </g>
  );
}

export function Arena({ vm, phase }: { vm: ViewModel; phase: Phase }) {
  const reduced = usePrefersReducedMotion();
  const layout = useMemo(() => computeLayout(vm, phase), [vm, phase]);
  const positions = useBubblePositions(vm, layout, phase, reduced);
  const settled = phase === 'locked' || phase === 'summary';

  return (
    <svg
      className={`arena${reduced ? ' reduced' : ''}`}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Bubbles deliberating"
    >
      {vm.venues.map((v) => {
        const l = layout.venues[v.venueId];
        return l ? <VenueOrb key={v.venueId} name={v.name} cuisine={v.cuisine} {...l} /> : null;
      })}
      {layout.consensus && <ConsensusBubble {...layout.consensus} />}
      {vm.bubbles.map((b) => {
        const n = positions.get(b.userId);
        if (!n) return null;
        return (
          <BubbleNode
            key={b.userId}
            name={b.displayName}
            status={b.status}
            x={n.x ?? n.tx}
            y={n.y ?? n.ty}
            r={n.r}
            present={b.present}
            pulse={
              phase === 'deadlock' && (b.status === 'stretching' || b.status === 'holding_firm')
            }
            compact={settled}
          />
        );
      })}
      {settled &&
        (Object.keys(layout.doers) as DoerKind[]).map((kind) => {
          const p = layout.doers[kind]!;
          const d = vm.doers[kind];
          return (
            <DoerBubble
              key={kind}
              kind={kind}
              state={d?.state ?? null}
              detail={d?.detail ?? null}
              {...p}
            />
          );
        })}
    </svg>
  );
}
