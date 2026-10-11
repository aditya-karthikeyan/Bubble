'use client';

/**
 * Feeds the view model from one of two sources: the server's /live room for a page token, or a
 * recorded fixture (?replay=basic) for development and as the demo backup. Every event is
 * validated with the shared zod schema; anything that doesn't parse is dropped.
 *
 * Events never apply in a burst. The engine publishes a whole deliberation (venues, scores,
 * merge, lock) within milliseconds, so a queue paces them with a dwell after the moments worth
 * watching. History that arrives on join plays as a fast recap, so a late viewer still sees the
 * crew come together instead of landing on the end state.
 */
import { PlanEvent, SOCKET } from '@bubbleworks/shared';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { SERVER_URL } from '../../app/site';
import basic from '../../fixtures/basic.json';
import deadlock from '../../fixtures/deadlock.json';
import { EMPTY, reduce, type ViewModel } from './view-model';

export const FIXTURES: Record<string, unknown[]> = { basic, deadlock };

export type FeedStatus =
  'connecting' | 'live' | 'reconnecting' | 'offline' | 'expired' | 'replay' | 'replay_done';

type Pace = 'fixture' | 'recap' | 'live';
type Action = { kind: 'event'; event: PlanEvent } | { kind: 'reset' };

function feedReducer(vm: ViewModel, action: Action): ViewModel {
  return action.kind === 'reset' ? EMPTY : reduce(vm, action.event);
}

function parse(raw: unknown): PlanEvent | null {
  const r = PlanEvent.safeParse(raw);
  return r.success ? r.data : null;
}

interface JoinAck {
  ok: boolean;
  error?: string;
  replay: unknown[];
}

/** Pause after an event before the next queued one, so the motion it causes reads. */
export const DWELL_MS: Partial<Record<PlanEvent['type'], number>> = {
  bubble_joined: 500,
  candidate_added: 450,
  round_complete: 2600,
  candidate_eliminated: 1000,
  bubble_merged: 2400,
  private_ask_sent: 1800,
  plan_locked: 1600,
  booking_confirmed: 800,
};

export function gapAfter(
  event: PlanEvent,
  next: PlanEvent | undefined,
  pace: Pace,
  backlog: number,
): number {
  const dwell = DWELL_MS[event.type] ?? 350;
  if (pace === 'recap') return Math.round(120 + dwell * 0.35);
  if (pace === 'live') return backlog > 12 ? 150 : dwell;
  const real = next ? new Date(next.at).getTime() - new Date(event.at).getTime() : 0;
  return Math.min(2200, Math.max(300, real * 3)) + dwell;
}

export function usePlanFeed(token: string, replay: string | null) {
  const [vm, dispatch] = useReducer(feedReducer, EMPTY);
  const [status, setStatus] = useState<FeedStatus>(replay ? 'replay' : 'connecting');
  const [run, setRun] = useState(0);
  const restart = useCallback(() => setRun((n) => n + 1), []);
  const queue = useRef<{ event: PlanEvent; pace: Pace }[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDrained = useRef<(() => void) | null>(null);

  const pump = useCallback(() => {
    if (timer.current) return;
    const item = queue.current.shift();
    if (!item) {
      onDrained.current?.();
      return;
    }
    dispatch({ kind: 'event', event: item.event });
    const gap = queue.current.length
      ? gapAfter(item.event, queue.current[0]!.event, item.pace, queue.current.length)
      : 0;
    timer.current = setTimeout(() => {
      timer.current = null;
      pump();
    }, gap);
  }, []);

  const enqueue = useCallback(
    (events: PlanEvent[], pace: Pace) => {
      queue.current.push(...events.map((event) => ({ event, pace })));
      pump();
    },
    [pump],
  );

  useEffect(() => {
    dispatch({ kind: 'reset' });
    queue.current = [];
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    onDrained.current = null;

    if (replay) {
      const events = (FIXTURES[replay] ?? []).map(parse).filter((e): e is PlanEvent => e !== null);
      setStatus('replay');
      onDrained.current = () => setStatus('replay_done');
      const start = setTimeout(() => enqueue(events, 'fixture'), 900);
      return () => {
        clearTimeout(start);
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
      };
    }

    setStatus('connecting');
    let joinedOnce = false;
    const socket = io(`${SERVER_URL}${SOCKET.namespace}`, { transports: ['websocket'] });
    socket.on('connect', () => {
      socket.emit(SOCKET.join, { token }, (ack: JoinAck) => {
        if (!ack.ok) {
          setStatus('expired');
          socket.close();
          return;
        }
        setStatus('live');
        const history = ack.replay.map(parse).filter((e): e is PlanEvent => e !== null);
        // First join: recap the story so far. Reconnect: the reducer skips what it has seen.
        enqueue(history, joinedOnce ? 'live' : 'recap');
        joinedOnce = true;
      });
    });
    socket.on(SOCKET.plan_event, (raw: unknown) => {
      const event = parse(raw);
      if (event) enqueue([event], 'live');
    });
    socket.on('disconnect', () => setStatus((s) => (s === 'expired' ? s : 'reconnecting')));
    socket.on('connect_error', () =>
      setStatus((s) => (s === 'expired' ? s : joinedOnce ? 'reconnecting' : 'offline')),
    );
    return () => {
      socket.close();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [token, replay, run, enqueue]);

  return { vm, status, restart };
}
