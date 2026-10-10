/**
 * pnpm p1:phase1
 * Runs a scripted plan through every state with real SQLite-backed timers, SIGKILLs the worker
 * while a plan is BOOKING with a pending timer, restarts it against the same database, and
 * shows the plan resuming to CLOSED. Prints the venue count at the end.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const worker = resolve(import.meta.dirname, 'phase1-worker.ts');
const dir = mkdtempSync(join(tmpdir(), 'bubbleworks-phase1-'));
const dbPath = join(dir, 'phase1.db');

function run(
  stage: 'fresh' | 'resume',
  onLine: (line: string, child: ChildProcess) => void,
): Promise<number | null> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', worker, '--db', dbPath, '--stage', stage],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env, NODE_ENV: 'test' },
      },
    );
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        console.log(`[run ${stage === 'fresh' ? 1 : 2}] ${line}`);
        onLine(line, child);
      }
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolveExit(signal === 'SIGKILL' ? -9 : code));
  });
}

async function main(): Promise<void> {
  console.log(`db: ${dbPath}`);
  let venueCount = 'unknown';

  const first = await run('fresh', (line, child) => {
    const m = /VENUE COUNT (\d+)/.exec(line);
    if (m) venueCount = m[1]!;
    if (line === 'READY_TO_KILL') {
      console.log(
        `\n>>> SIGKILL pid ${child.pid} while the plan is BOOKING with a pending call_timeout\n`,
      );
      child.kill('SIGKILL');
    }
  });
  if (first !== -9) throw new Error(`run 1 exited unexpectedly with ${first}`);

  console.log('>>> restarting against the same database\n');
  const second = await run('resume', () => undefined);
  if (second !== 0) throw new Error(`run 2 exited with ${second}`);

  console.log(`\nvenues in data/venues.json: ${venueCount}`);
  console.log('PHASE 1 OK');
  rmSync(dir, { recursive: true, force: true });
}

main().catch((err: unknown) => {
  console.error('PHASE 1 FAILED', err);
  process.exit(1);
});
