import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CrewDirectory } from '@bubbleworks/shared';
import { DEMO_GROUP, FakeCrewDirectory } from '@bubbleworks/shared/fakes';
import type { Runtime } from '../runtime.js';
import { testRuntime } from '../test-helpers.js';

/** The fake and the database implementation must behave the same. */
describe.each([
  [
    'FakeCrewDirectory',
    () => ({ dir: new FakeCrewDirectory() as CrewDirectory, close: () => undefined }),
  ],
  [
    'DbCrewDirectory',
    () => {
      const rt: Runtime = testRuntime();
      return { dir: rt.crews as CrewDirectory, close: () => rt.close() };
    },
  ],
])('%s', (_name, make) => {
  let dir: CrewDirectory;
  let close: () => void;
  beforeEach(() => {
    ({ dir, close } = make());
  });
  afterEach(() => close());

  it('serves the seeded personas and the demo crew by chat id', async () => {
    const ava = await dir.userByHandle('+10000000001');
    expect(ava?.id).toBe('user_ava');
    expect(await dir.userByHandle('+19999999999')).toBeNull();
    const crew = await dir.crewByChatId('crew:group_demo');
    expect(crew).toMatchObject({ id: 'group_demo', status: 'active', chatId: DEMO_GROUP.chatId });
    expect((await dir.membersOf('group_demo')).map((u) => u.id).sort()).toEqual([
      'user_ava',
      'user_ben',
      'user_chloe',
      'user_dev',
      'user_eli',
    ]);
    expect((await dir.crewsOf('user_ava')).map((g) => g.id)).toEqual(['group_demo']);
  });

  it('creates users idempotently by handle and patches them after signup', async () => {
    const a = await dir.createUser({
      displayName: 'Pranav',
      handle: '+19195550100',
      email: 'p@x.y',
    });
    const b = await dir.createUser({ displayName: 'P again', handle: '+19195550100' });
    expect(b.id).toBe(a.id);
    expect(a.onboardedAt).toBeNull();
    const updated = await dir.updateUser(a.id, {
      bubbleNumber: '+19195550999',
      onboardedAt: '2026-10-10T20:00:00.000Z',
    });
    expect(updated).toMatchObject({
      bubbleNumber: '+19195550999',
      onboardedAt: '2026-10-10T20:00:00.000Z',
      email: 'p@x.y',
    });
    expect(await dir.userById(a.id)).toEqual(updated);
  });

  it('a crew is pending until every member confirms; the creator is pre-confirmed', async () => {
    const crew = await dir.createCrew({
      name: 'thursday crew',
      createdByUserId: 'user_ava',
      memberIds: ['user_ben', 'user_chloe'],
    });
    expect(crew.status).toBe('pending');
    expect(crew.chatId).toBe(`crew:${crew.id}`);
    expect(crew.createdByUserId).toBe('user_ava');
    expect((await dir.membersOf(crew.id)).map((u) => u.id).sort()).toEqual([
      'user_ava',
      'user_ben',
      'user_chloe',
    ]);

    expect((await dir.confirmMember(crew.id, 'user_ben')).status).toBe('pending');
    expect((await dir.confirmMember(crew.id, 'user_ben')).status).toBe('pending');
    expect((await dir.confirmMember(crew.id, 'user_chloe')).status).toBe('active');
    await expect(dir.confirmMember(crew.id, 'user_eli')).rejects.toThrow();

    expect((await dir.addMember(crew.id, 'user_dev')).status).toBe('pending');
    expect((await dir.removeMember(crew.id, 'user_dev')).status).toBe('active');
    expect((await dir.crewsOf('user_ben')).map((g) => g.id)).toContain(crew.id);
  });

  it('a solo crew is active immediately', async () => {
    const solo = await dir.createCrew({
      name: 'me',
      createdByUserId: 'user_dev',
      memberIds: ['user_dev'],
    });
    expect(solo.status).toBe('active');
  });
});
