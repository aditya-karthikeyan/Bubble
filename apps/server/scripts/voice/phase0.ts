/**
 * pnpm p4:phase0
 * Places the Twilio test call (when the number is set up), then checks the live page path:
 * a Socket.io ping and join against the deployed server, and the deployed page URL.
 */
import { spawnSync } from 'node:child_process';
import { SOCKET, newPageToken } from '@bubbleworks/shared';
import { io as connect } from 'socket.io-client';

const server = (
  process.env['SERVER_PUBLIC_URL'] ||
  process.env['NEXT_PUBLIC_SOCKET_URL'] ||
  ''
).replace(/\/$/, '');
const web = (process.env['WEB_PUBLIC_URL'] || '').replace(/\/$/, '');

function testCall(): void {
  const ready = ['TWILIO_PHONE_NUMBER', 'ELEVENLABS_PHONE_NUMBER_ID', 'TEST_CALL_NUMBER'].every(
    (k) => process.env[k],
  );
  if (!ready) {
    console.log('test call: skipped (Twilio number not imported yet; run pnpm p4:number)');
    return;
  }
  spawnSync(process.execPath, ['--import', 'tsx', 'scripts/voice/testcall.ts'], {
    stdio: 'inherit',
  });
}

async function liveCheck(): Promise<void> {
  if (!server || !web)
    throw new Error('Set SERVER_PUBLIC_URL (or NEXT_PUBLIC_SOCKET_URL) and WEB_PUBLIC_URL in .env');
  const socket = connect(`${server}${SOCKET.namespace}`, {
    transports: ['websocket'],
    timeout: 10_000,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  const t0 = performance.now();
  const pong = await new Promise<{ at: string }>((resolve) => socket.emit(SOCKET.ping, resolve));
  console.log(`socket ping: ${(performance.now() - t0).toFixed(0)} ms, server time ${pong.at}`);

  const token = newPageToken();
  const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) =>
    socket.emit(SOCKET.join, { token }, resolve),
  );
  console.log(`join with a fresh token: ok=${ack.ok}${ack.error ? ` (${ack.error})` : ''}`);
  socket.close();

  const res = await fetch(`${web}/p/${token}`);
  console.log(`live page: ${web}/p/${token} -> ${res.status}`);
}

async function main(): Promise<void> {
  testCall();
  await liveCheck();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
