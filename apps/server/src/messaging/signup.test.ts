import { FakeCrewDirectory } from '@bubbleworks/shared/fakes';
import { describe, expect, it, vi } from 'vitest';
import { PhotonUsers, splitName } from './photon-users.js';
import { signup } from './signup.js';

function photonWith(assigned: string) {
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ succeed: true, data: {} });
    return Response.json({
      succeed: true,
      data: { users: [{ id: 'u1', phoneNumber: '+15550000009', assignedPhoneNumber: assigned }] },
    });
  });
  const photon = new PhotonUsers({
    apiUrl: 'https://spectrum.example',
    projectId: 'proj',
    projectSecret: 'secret',
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { photon, fetch };
}

describe('signup', () => {
  it('registers with Photon, creates the user, and returns the bubble number', async () => {
    const crews = new FakeCrewDirectory();
    const { photon, fetch } = photonWith('+16285550000');
    const result = await signup(
      { crews, photon },
      { name: 'Dee Dee', email: 'dee@example.com', phone: '+15550000009' },
    );
    expect(result.bubbleNumber).toBe('+16285550000');
    expect(result.smsLink).toBe('sms:+16285550000&body=hi%20bubble');
    expect(result.user).toMatchObject({ displayName: 'Dee Dee', handle: '+15550000009' });
    const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      type: 'shared',
      firstName: 'Dee',
      lastName: 'Dee',
      email: 'dee@example.com',
      phoneNumber: '+15550000009',
    });
    expect(
      String(post[1]!.headers && (post[1]!.headers as Record<string, string>)['authorization']),
    ).toBe(`Basic ${Buffer.from('proj:secret').toString('base64')}`);
  });

  it('is idempotent by phone', async () => {
    const crews = new FakeCrewDirectory();
    const first = await signup(
      { crews, photon: null },
      { name: 'Dee', email: 'd@x.co', phone: '+15550000009' },
    );
    const again = await signup(
      { crews, photon: null },
      { name: 'Dee', email: 'd@x.co', phone: '+15550000009' },
    );
    expect(again.user.id).toBe(first.user.id);
  });

  it('a join code from a crew link puts the new person in that crew', async () => {
    const crews = new FakeCrewDirectory();
    const crew = await crews.createCrew({
      name: 'the boys',
      createdByUserId: 'user_ava',
      memberIds: [],
    });
    const result = await signup(
      { crews, photon: null },
      { name: 'Dee', email: 'd@x.co', phone: '+15550000010', crewCode: crew.joinCode! },
    );
    expect(result.crewName).toBe('the boys');
    expect((await crews.membersOf(crew.id)).map((u) => u.id)).toContain(result.user.id);
    expect((await crews.crewById(crew.id))?.status).toBe('active');
    expect(result).toMatchObject({ crewId: crew.id, newMember: true, created: true });
    // The same person again: already in, so nobody is told twice.
    const again = await signup(
      { crews, photon: null },
      { name: 'Dee', email: 'd@x.co', phone: '+15550000010', crewCode: crew.joinCode! },
    );
    expect(again).toMatchObject({ crewName: 'the boys', newMember: false, created: false });
  });

  it('rejects a phone that is not E.164 and a bad email', async () => {
    const crews = new FakeCrewDirectory();
    await expect(
      signup({ crews, photon: null }, { name: 'D', email: 'd@x.co', phone: '555-1234' }),
    ).rejects.toThrow();
    await expect(
      signup({ crews, photon: null }, { name: 'D', email: 'nope', phone: '+15550000009' }),
    ).rejects.toThrow();
  });

  it('splits names the way Photon needs them', () => {
    expect(splitName('Ada Lovelace')).toEqual({ firstName: 'Ada', lastName: 'Lovelace' });
    expect(splitName('Cher')).toEqual({ firstName: 'Cher', lastName: '-' });
  });
});
