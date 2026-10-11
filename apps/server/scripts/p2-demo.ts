/**
 * Demo day for the messaging side: real people in the demo crew, judges in by QR, the server on
 * the line. Works on DATABASE_PATH, so it pairs with `pnpm demo:reset` (clears plans between
 * runs, keeps people and crews).
 *
 *   pnpm p2:demo crew [handles...]          team crew from handles (or P2_DEMO_HANDLES)
 *   pnpm p2:demo add-judge "Name" +1555...  register a judge, add to the crew, print a QR
 *        [--imessage-email judge@icloud.com] when their iMessage runs on an Apple ID email
 *   pnpm p2:demo status                     who is in, who has texted their bubble
 *   pnpm p2:demo serve                      the real server on the line, DEMO_MODE (LINE LOCK)
 *
 * The QR opens Messages to the judge's own bubble with "hi" typed; one tap to send. On Photon Pro
 * that first text is required before their bubble can message them.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import QRCode from 'qrcode';
import { DEMO_GROUP } from '@bubbleworks/shared/fakes';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/events/bus.js';
import { loadMessagingConfig } from '../src/messaging/index.js';
import { PhotonUsers } from '../src/messaging/photon-users.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

const CREW_NAME = 'demo crew';
const [command, ...args] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function photon(): PhotonUsers {
  const m = loadMessagingConfig();
  if (!m.SPECTRUM_PROJECT_ID || !m.SPECTRUM_PROJECT_SECRET) {
    throw new Error('Set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET in .env');
  }
  return new PhotonUsers({
    apiUrl: m.SPECTRUM_API_URL,
    projectId: m.SPECTRUM_PROJECT_ID,
    projectSecret: m.SPECTRUM_PROJECT_SECRET,
  });
}

function open(): Runtime {
  return createRuntime(loadConfig({ ...process.env, SEED_ON_BOOT: 'true' }), {
    seed: true,
    log: silentLogger,
  });
}

/** The demo crew's id, created (active, centered on the hackathon) if it does not exist. */
async function demoCrew(rt: Runtime, creatorId: string): Promise<string> {
  const row = rt.handle.sqlite.prepare('SELECT id FROM groups WHERE name = ?').get(CREW_NAME) as
    { id: string } | undefined;
  if (row) return row.id;
  const crew = await rt.crews.createCrew({
    name: CREW_NAME,
    createdByUserId: creatorId,
    memberIds: [creatorId],
  });
  rt.handle.sqlite
    .prepare('UPDATE groups SET center_lat = ?, center_lng = ? WHERE id = ?')
    .run(DEMO_GROUP.center?.lat ?? null, DEMO_GROUP.center?.lng ?? null, crew.id);
  return crew.id;
}

async function join(rt: Runtime, crewId: string, userId: string): Promise<void> {
  const members = await rt.crews.membersOf(crewId);
  if (!members.some((m) => m.id === userId)) await rt.crews.addMember(crewId, userId);
  await rt.crews.confirmMember(crewId, userId);
}

async function crew(): Promise<void> {
  const handles = args.length
    ? args
    : (process.env['P2_DEMO_HANDLES'] ?? '').split(',').filter(Boolean);
  if (!handles.length) throw new Error('Pass handles or set P2_DEMO_HANDLES');
  const p = photon();
  const names = await p.firstNames();
  const rt = open();
  let crewId: string | null = null;
  for (const handle of handles) {
    const bubbleNumber = await p.bubbleNumberFor(handle);
    if (!bubbleNumber) throw new Error(`…${handle.slice(-4)} is not registered with Photon`);
    const user = await rt.crews.createUser({
      displayName: names.get(handle.toLowerCase()) ?? names.get(handle) ?? `…${handle.slice(-4)}`,
      handle,
      bubbleNumber,
    });
    // The team has texted their bubbles already; judges get onboarded by their first text.
    if (!user.onboardedAt)
      await rt.crews.updateUser(user.id, { onboardedAt: new Date().toISOString() });
    crewId ??= await demoCrew(rt, user.id);
    await join(rt, crewId, user.id);
    console.log(`✓ ${user.displayName} (bubble ${bubbleNumber})`);
  }
  console.log(`\n${CREW_NAME}: ${crewId} in ${loadConfig().DATABASE_PATH}`);
  rt.close();
}

async function addJudge(): Promise<void> {
  const [name, phone] = args;
  if (!name || !phone || !/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new Error('Usage: add-judge "Name" +15551234567 [--imessage-email x@icloud.com]');
  }
  const imessageEmail = flag('--imessage-email');
  // Email is optional on Photon; pass it only when the judge's iMessage runs on it.
  const email = imessageEmail ?? null;
  const [firstName, ...rest] = name.trim().split(/\s+/);
  const p = photon();
  const { bubbleNumber } = await p.register({
    firstName: firstName ?? name,
    lastName: rest.join(' ') || '-',
    email,
    phone,
  });
  const rt = open();
  const handle = imessageEmail ?? phone;
  const user = await rt.crews.createUser({ displayName: name.trim(), handle, bubbleNumber });
  const firstMember = (
    rt.handle.sqlite.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get() as {
      id: string;
    }
  ).id;
  const crewId = await demoCrew(rt, firstMember);
  await join(rt, crewId, user.id);
  rt.close();

  const sms = `sms:${bubbleNumber}&body=${encodeURIComponent('hi')}`;
  const png = resolve(`judge-${phone.replace(/\D/g, '')}.png`);
  writeFileSync(png, await QRCode.toBuffer(sms, { width: 600, margin: 2 }));
  console.log(await QRCode.toString(sms, { type: 'terminal', small: true }));
  console.log(`${name}: scan, then tap send. Their bubble is ${bubbleNumber}.`);
  console.log(`QR image: ${png}`);
  console.log(`They're in ${CREW_NAME}; plans reach them once that first "hi" lands.`);
}

async function status(): Promise<void> {
  const rt = open();
  const row = rt.handle.sqlite.prepare('SELECT id FROM groups WHERE name = ?').get(CREW_NAME) as
    { id: string } | undefined;
  if (!row) {
    console.log(`No ${CREW_NAME} yet. Run: pnpm p2:demo crew`);
    rt.close();
    return;
  }
  const crewRow = await rt.crews.crewById(row.id);
  console.log(`${CREW_NAME} (${crewRow?.status}) in ${loadConfig().DATABASE_PATH}`);
  for (const m of await rt.crews.membersOf(row.id)) {
    console.log(
      `  ${m.onboardedAt ? '✓' : '…'} ${m.displayName.padEnd(16)} bubble ${m.bubbleNumber ?? '?'}  ${m.onboardedAt ? 'ready' : 'waiting for their first text'}`,
    );
  }
  const active = rt.plans.findAllActive();
  console.log(
    `active plans: ${active.length}${active.length ? ' (pnpm demo:reset clears them)' : ''}`,
  );
  rt.close();
}

function serve(): void {
  console.log(
    'Starting the server on the real line (DEMO_MODE). Post LINE LOCK first. Ctrl-C to stop.',
  );
  const child = spawn('tsx', ['--env-file-if-exists=../../.env', 'src/index.ts'], {
    stdio: 'inherit',
    env: { ...process.env, SPECTRUM_PROVIDER: 'imessage', DEMO_MODE: 'true' },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

switch (command) {
  case 'crew':
    await crew();
    break;
  case 'add-judge':
    await addJudge();
    break;
  case 'status':
    await status();
    break;
  case 'serve':
    serve();
    break;
  default:
    console.log('Usage: pnpm p2:demo <crew|add-judge|status|serve> (see scripts/p2-demo.ts)');
}
