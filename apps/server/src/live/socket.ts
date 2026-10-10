/**
 * Socket.io bridge for the live page. Viewers join the room for a plan's page token and
 * receive every PlanEvent as it is published, plus a replay of past events on join.
 */
import type { Server as HttpServer } from 'node:http';
import { SOCKET, type PlanEvent } from '@bubbleworks/shared';
import type { FastifyBaseLogger } from 'fastify';
import { Server } from 'socket.io';
import { z } from 'zod';

const JoinPayload = z.object({ token: z.string().min(8).max(64) });

export interface JoinAck {
  ok: boolean;
  error?: string;
  replay: PlanEvent[];
}

export interface LiveBridgeOptions {
  /** Resolve a page token to its replay, or null when the token is unknown or expired. */
  replayForToken: (token: string) => Promise<PlanEvent[] | null>;
  corsOrigin: string | string[] | boolean;
  log: FastifyBaseLogger;
}

export interface LiveBridge {
  io: Server;
  /** Broadcast an event to every viewer of the plan's page. */
  broadcast(token: string, event: PlanEvent): void;
  close(): Promise<void>;
}

export function attachLiveBridge(httpServer: HttpServer, options: LiveBridgeOptions): LiveBridge {
  const io = new Server(httpServer, {
    cors: { origin: options.corsOrigin, methods: ['GET', 'POST'] },
    serveClient: false,
  });
  const nsp = io.of(SOCKET.namespace);

  nsp.on('connection', (socket) => {
    options.log.debug({ socketId: socket.id }, 'live viewer connected');

    socket.on(SOCKET.join, async (raw: unknown, ack?: (a: JoinAck) => void) => {
      const parsed = JoinPayload.safeParse(raw);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'bad token', replay: [] });
        return;
      }
      const replay = await options.replayForToken(parsed.data.token);
      if (replay === null) {
        ack?.({ ok: false, error: 'unknown or expired token', replay: [] });
        return;
      }
      await socket.join(SOCKET.room(parsed.data.token));
      ack?.({ ok: true, replay });
    });

    socket.on(SOCKET.ping, (ack?: (a: { pong: true; at: string }) => void) => {
      ack?.({ pong: true, at: new Date().toISOString() });
    });
  });

  return {
    io,
    broadcast(token, event) {
      nsp.to(SOCKET.room(token)).emit(SOCKET.plan_event, event);
    },
    close: () =>
      new Promise<void>((resolve) => {
        io.close(() => resolve());
      }),
  };
}
