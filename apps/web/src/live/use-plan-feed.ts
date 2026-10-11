'use client';

/**
 * Feeds the view model from one of two sources: the server's /live room for a page token, or a
 * recorded fixture (?replay=basic) for development and as the demo backup. Every event is
 * validated with the shared zod schema; anything that doesn't parse is dropped.
 */
import { PlanEvent, SOCKET } from '@bubbleworks/shared';
import { useCallback, useEffect, useReducer, useState } from 'react';
import { io } from 'socket.io-client';
import { SERVER_URL } from '../../app/site';
import basic from '../../fixtures/basic.json';
import deadlock from '../../fixtures/deadlock.json';
import { EMPTY, reduce, type ViewModel } from './view-model';

export const FIXTURES: Record<string, unknown[]> = { basic, deadlock };

export type FeedStatus =
  'connecting' | 'live' | 'reconnecting' | 'offline' | 'expired' | 'replay' | 'replay_done';

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

/** Extra pause after the moments worth watching, so the drift and merges read on a phone. */
const DWELL_MS: Partial<Record<PlanEvent['type'], number>> = {
  candidate_added: 250,
  round_complete: 2400,
  candidate_eliminated: 900,
  bubble_merged: 2000,
  private_ask_sent: 1800,
  plan_locked: 1400,
};

/** Gap before the next replayed event: the recorded gap stretched, plus any dwell. */
function replayGap(prev: PlanEvent, next: PlanEvent): number {
  const real = new Date(next.at).getTime() - new Date(prev.at).getTime();
  return Math.min(2200, Math.max(450, real * 3)) + (DWELL_MS[prev.type] ?? 0);
}

export function usePlanFeed(token: string, replay: string | null) {
  const [vm, dispatch] = useReducer(feedReducer, EMPTY);
  const [status, setStatus] = useState<FeedStatus>(replay ? 'replay' : 'connecting');
  const [run, setRun] = useState(0);
  const restart = useCallback(() => setRun((n) => n + 1), []);

  useEffect(() => {
    dispatch({ kind: 'reset' });
    if (replay) {
      const events = (FIXTURES[replay] ?? []).map(parse).filter((e): e is PlanEvent => e !== null);
      setStatus('replay');
      const timers: ReturnType<typeof setTimeout>[] = [];
      let t = 900;
      events.forEach((event, i) => {
        if (i > 0) t += replayGap(events[i - 1]!, event);
        timers.push(setTimeout(() => dispatch({ kind: 'event', event }), t));
      });
      timers.push(setTimeout(() => setStatus('replay_done'), t + 600));
      return () => timers.forEach(clearTimeout);
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
        joinedOnce = true;
        setStatus('live');
        for (const raw of ack.replay) {
          const event = parse(raw);
          if (event) dispatch({ kind: 'event', event });
        }
      });
    });
    socket.on(SOCKET.plan_event, (raw: unknown) => {
      const event = parse(raw);
      if (event) dispatch({ kind: 'event', event });
    });
    socket.on('disconnect', () => setStatus((s) => (s === 'expired' ? s : 'reconnecting')));
    socket.on('connect_error', () =>
      setStatus((s) => (s === 'expired' ? s : joinedOnce ? 'reconnecting' : 'offline')),
    );
    return () => {
      socket.close();
    };
  }, [token, replay, run]);

  return { vm, status, restart };
}
