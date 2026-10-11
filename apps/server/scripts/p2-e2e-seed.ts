/**
 * Seeds a database for a real end-to-end run on the line: the given people (registered with
 * Photon, each has texted their bubble) become one confirmed crew. Then start the real server
 * against the same DATABASE_PATH with SPECTRUM_PROVIDER=imessage.
 *
 *   DATABASE_PATH=/tmp/e2e.db P2_E2E_HANDLES=+1...,+1... pnpm --filter @bubbleworks/server p2:e2e-seed
 */
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/events/bus.js';
import { loadMessagingConfig } from '../src/messaging/index.js';
import { PhotonUsers } from '../src/messaging/photon-users.js';
import { createRuntime } from '../src/runtime.js';

const handles = (process.env['P2_E2E_HANDLES'] ?? '').split(',').filter(Boolean);
if (handles.length < 2) throw new Error('Set P2_E2E_HANDLES to two or more crew handles');
const config = loadConfig({ ...process.env, SEED_ON_BOOT: 'true' });
const messaging = loadMessagingConfig();
const runtime = createRuntime(config, { seed: true, log: silentLogger });
const photon = new PhotonUsers({
  apiUrl: messaging.SPECTRUM_API_URL,
  projectId: messaging.SPECTRUM_PROJECT_ID!,
  projectSecret: messaging.SPECTRUM_PROJECT_SECRET!,
});

const names = await photon.firstNames();
const ids: string[] = [];
for (const handle of handles) {
  const bubbleNumber = await photon.bubbleNumberFor(handle);
  if (!bubbleNumber) throw new Error(`…${handle.slice(-4)} is not registered with Photon`);
  const user = await runtime.crews.createUser({
    displayName: names.get(handle.toLowerCase()) ?? names.get(handle) ?? `…${handle.slice(-4)}`,
    handle,
    bubbleNumber,
  });
  await runtime.crews.updateUser(user.id, { onboardedAt: new Date().toISOString() });
  ids.push(user.id);
  console.log(`${user.displayName}: ${user.id} (bubble …${bubbleNumber.slice(-4)})`);
}
let crew = await runtime.crews.createCrew({
  name: 'test crew',
  createdByUserId: ids[0]!,
  memberIds: ids,
});
for (const id of ids) crew = await runtime.crews.confirmMember(crew.id, id);
console.log(`crew ${crew.id} ${crew.status} (${ids.length} members) in ${config.DATABASE_PATH}`);
runtime.close();
