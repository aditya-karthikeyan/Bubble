/**
 * pnpm p1:phase0
 * Prints the /health response of the deployed server and a Socket.io round trip from a test
 * client. Target: SERVER_PUBLIC_URL, or PHASE0_URL, or http://localhost:3001.
 */
import { SOCKET } from '@bubbleworks/shared';
import { io as connect } from 'socket.io-client';

const target = (
  process.env['PHASE0_URL'] ??
  process.env['SERVER_PUBLIC_URL'] ??
  'http://localhost:3001'
).replace(/\/$/, '');

async function main(): Promise<void> {
  console.log(`target: ${target}`);

  const t0 = performance.now();
  const res = await fetch(`${target}/health`);
  const health: unknown = await res.json();
  console.log(`GET /health -> ${res.status} in ${(performance.now() - t0).toFixed(0)} ms`);
  console.log(JSON.stringify(health, null, 2));
  if (!res.ok) throw new Error('health check failed');

  const socket = connect(`${target}${SOCKET.namespace}`, {
    transports: ['websocket'],
    timeout: 10_000,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err) => reject(err));
  });
  console.log(`socket connected: id=${socket.id}`);

  const t1 = performance.now();
  const pong = await new Promise<{ pong: boolean; at: string }>((resolve) => {
    socket.emit(SOCKET.ping, resolve);
  });
  console.log(`ping -> ${JSON.stringify(pong)} in ${(performance.now() - t1).toFixed(0)} ms`);

  const join = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    socket.emit(SOCKET.join, { token: 'phase0-probe-token' }, resolve);
  });
  console.log(`join with unknown token -> ${JSON.stringify(join)} (refusal expected)`);

  socket.disconnect();
  console.log('PHASE 0 OK');
}

main().catch((err: unknown) => {
  console.error('PHASE 0 FAILED', err);
  process.exit(1);
});
