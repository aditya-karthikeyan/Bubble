'use client';

/**
 * Phase 0 placeholder: joins the plan's Socket.io room on the server, then prints the replay
 * and every live event as raw JSON. Phase 2 swaps this for the reducer and the arena.
 */
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

// Mirrors SOCKET in @bubbleworks/shared. Imported directly once shared has a browser-safe entry.
const SOCKET = {
  namespace: '/live',
  join: 'join',
  ping: 'ping',
  plan_event: 'plan_event',
} as const;

const SERVER_URL = (process.env['NEXT_PUBLIC_SOCKET_URL'] ?? 'http://localhost:3001').replace(
  /\/$/,
  '',
);

interface JoinAck {
  ok: boolean;
  error?: string;
  replay: unknown[];
}

type Line = { at: string; kind: 'info' | 'error' | 'event'; text: string };

export function LiveFeed({ token }: { token: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState('connecting');

  useEffect(() => {
    const add = (kind: Line['kind'], text: string) =>
      setLines((prev) => [...prev, { at: new Date().toLocaleTimeString(), kind, text }]);

    const socket = io(`${SERVER_URL}${SOCKET.namespace}`, { transports: ['websocket'] });

    socket.on('connect', () => {
      setStatus('connected');
      const t0 = performance.now();
      socket.emit(SOCKET.ping, (pong: { pong: boolean; at: string }) => {
        add(
          'info',
          `server ping ok in ${(performance.now() - t0).toFixed(0)} ms (server time ${pong.at})`,
        );
      });
      socket.emit(SOCKET.join, { token }, (ack: JoinAck) => {
        if (!ack.ok) {
          setStatus('expired');
          add('error', `join refused: ${ack.error ?? 'unknown'}`);
          return;
        }
        add('info', `joined, replaying ${ack.replay.length} events`);
        for (const event of ack.replay) add('event', JSON.stringify(event));
      });
    });
    socket.on(SOCKET.plan_event, (event: unknown) => add('event', JSON.stringify(event)));
    socket.on('connect_error', (err) => {
      setStatus('offline');
      add('error', `connect error: ${err.message}`);
    });
    socket.on('disconnect', () => setStatus('disconnected'));

    return () => {
      socket.close();
    };
  }, [token]);

  return (
    <section>
      <p>
        Server: <code>{SERVER_URL}</code> · status: <strong>{status}</strong>
      </p>
      <ol
        style={{
          paddingLeft: 20,
          fontFamily: 'ui-monospace, monospace',
          fontSize: 12,
          wordBreak: 'break-all',
        }}
      >
        {lines.map((l, i) => (
          <li
            key={i}
            style={{
              color: l.kind === 'error' ? '#b00020' : l.kind === 'event' ? '#0b2a3d' : '#2a6f97',
            }}
          >
            {l.at} {l.text}
          </li>
        ))}
      </ol>
    </section>
  );
}
