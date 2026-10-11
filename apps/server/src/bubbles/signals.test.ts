import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BusyInterval, User } from '@bubbleworks/shared';
import { FakeMessaging } from '@bubbleworks/shared/fakes';
import type { Runtime } from '../runtime.js';
import { testRuntime } from '../test-helpers.js';
import { RuleExtractor, type ExtractedFact, type FactExtractor } from './extract.js';
import { mightContainFact } from './learner.js';
import { DbBubbleService } from './service.js';
import {
  inQuietHours,
  parsePresenceCommand,
  presenceUntil,
  SignalCache,
  type FreeBusySource,
  type LocationFix,
  type LocationSource,
} from './signals.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SignalCache', () => {
  it('returns a fresh value inside the budget and caches it for the TTL', async () => {
    const cache = new SignalCache<number>('t', 60_000, { budgetMs: 100 });
    let calls = 0;
    const fetch = async () => ++calls;
    expect(await cache.read('k', fetch)).toMatchObject({ value: 1, from: 'fresh' });
    expect(await cache.read('k', fetch)).toMatchObject({ value: 1, from: 'cache' });
    expect(calls).toBe(1);
  });

  it('answers within the budget from cache when the source is slow, then lands the fetch', async () => {
    let now = 0;
    const cache = new SignalCache<string>('t', 1_000, { budgetMs: 50, now: () => now });
    await cache.read('k', async () => 'old');
    now = 5_000; // expired
    const t0 = performance.now();
    const slow = await cache.read('k', async () => {
      await sleep(200);
      return 'new';
    });
    expect(performance.now() - t0).toBeLessThan(150);
    expect(slow).toMatchObject({ value: 'old', from: 'cache' });
    await sleep(250);
    expect(cache.peek('k')?.value).toBe('new');
  });

  it('shares one in-flight fetch between concurrent readers', async () => {
    const cache = new SignalCache<number>('t', 0, { budgetMs: 500 });
    let calls = 0;
    const fetch = async () => {
      calls++;
      await sleep(20);
      return calls;
    };
    const [a, b] = await Promise.all([cache.read('k', fetch), cache.read('k', fetch)]);
    expect(calls).toBe(1);
    expect(a.value).toBe(1);
    expect(b.value).toBe(1);
  });

  it('returns none with no cache when the source fails', async () => {
    const cache = new SignalCache<number>('t', 1_000, { budgetMs: 50 });
    expect(
      await cache.read('k', async () => {
        throw new Error('down');
      }),
    ).toMatchObject({ value: null, from: 'none' });
  });
});

describe('presence helpers', () => {
  it('parses commands', () => {
    expect(parsePresenceCommand('busy')).toBe('focus');
    expect(parsePresenceCommand('Going to bed!')).toBe('sleep');
    expect(parsePresenceCommand('driving')).toBe('driving');
    expect(parsePresenceCommand("I'm back")).toBe('available');
    expect(parsePresenceCommand('busy week but dinner thursday?')).toBeNull();
  });

  it('sleep lasts until 07:00 New York, the others 3 hours', () => {
    const at2330 = new Date('2026-10-11T03:30:00.000Z'); // 23:30 EDT
    expect(presenceUntil('sleep', at2330)).toBe('2026-10-11T11:00:00.000Z'); // 07:00 EDT
    expect(presenceUntil('focus', at2330)).toBe('2026-10-11T06:30:00.000Z');
    expect(inQuietHours(at2330)).toBe(true);
    expect(inQuietHours(new Date('2026-10-10T22:00:00.000Z'))).toBe(false); // 18:00 EDT
  });

  it('flags only texts that could state a fact', () => {
    expect(mightContainFact('lol ok')).toBe(false);
    expect(mightContainFact('see you at 7')).toBe(false);
    expect(mightContainFact("I'm allergic to shellfish fyi")).toBe(true);
    expect(mightContainFact('broke till friday, nothing over $15')).toBe(true);
    expect(mightContainFact('that place was mid')).toBe(true);
  });
});

class SlowExtractor implements FactExtractor {
  private readonly rules = new RuleExtractor();
  async extract(
    text: string,
    hint: Parameters<FactExtractor['extract']>[1],
  ): Promise<ExtractedFact[]> {
    await sleep(30);
    return this.rules.extract(text, hint);
  }
}

describe('DbBubbleService signals and learning', () => {
  let rt: Runtime;
  let messaging: FakeMessaging;
  let bubbles: DbBubbleService;
  let clock: Date;
  let location: LocationFix | null;
  let locationDelay: number;
  let busy: BusyInterval[] | null;
  let seq = 0;

  beforeEach(() => {
    rt = testRuntime();
    messaging = new FakeMessaging({ print: false });
    clock = new Date('2026-10-10T22:00:00.000Z'); // Saturday 18:00 New York
    location = { lat: 35.9095, lng: -79.0469, capturedAt: clock.toISOString() };
    locationDelay = 0;
    busy = [];
    const locations: LocationSource = {
      get: async () => {
        await sleep(locationDelay);
        return location;
      },
    };
    const freeBusy: FreeBusySource = { busy: async () => busy };
    bubbles = new DbBubbleService({
      db: rt.db,
      crews: rt.crews,
      messaging,
      extractor: new SlowExtractor(),
      locations,
      freeBusy,
      signalBudgetMs: 100,
      now: () => clock,
    });
  });
  afterEach(() => rt.close());

  const dm = (user: User, text: string) =>
    bubbles.onPrivateMessage({
      messageId: `s${++seq}`,
      userId: user.id,
      text,
      at: clock.toISOString(),
    });
  const lastTo = (userId: string) =>
    messaging.sent
      .flatMap((s) =>
        s.kind === 'private_text' && s.input.userId === userId ? [s.input.text] : [],
      )
      .at(-1) ?? '';

  async function onboarded(name: string, phone: string): Promise<User> {
    const u = await rt.crews.createUser({ displayName: name, handle: phone });
    for (const t of ['hi', 'none', '30', 'skip', 'skip']) await dm(u, t);
    expect(bubbles.isOnboarded(u.id)).toBe(true);
    return u;
  }

  it('presence follows commands, then calendar, then quiet hours', async () => {
    const u = await onboarded('Pat', '+19195550201');
    expect(await bubbles.getPresence(u.id)).toBe('available');

    await dm(u, 'busy');
    expect(lastTo(u.id)).toMatch(/^Got it, you're busy until 9:00 PM\. No pings/);
    expect(await bubbles.getPresence(u.id)).toBe('focus');
    await dm(u, 'back');
    expect(await bubbles.getPresence(u.id)).toBe('available');

    bubbles.busyCache.delete(`${u.id}|2026-10-10T04:00:00.000Z|2026-10-11T04:00:00.000Z`);
    busy = [{ start: '2026-10-10T21:30:00.000Z', end: '2026-10-10T23:00:00.000Z' }];
    expect(await bubbles.getPresence(u.id)).toBe('focus');

    clock = new Date('2026-10-11T04:30:00.000Z'); // 00:30 New York, new day, no busy block
    busy = [];
    expect(await bubbles.getPresence(u.id)).toBe('sleep');
  });

  it('reads Find My within budget and falls back to the onboarding neighborhood', async () => {
    const u = await onboarded('Quin', '+19195550202');
    // The area is no longer an onboarding question; a pin or a chat remark records it.
    await bubbles.recordFact({
      userId: u.id,
      type: 'neighborhood',
      value: 'Franklin St',
      hard: false,
      confidence: 0.8,
      source: 'chat',
      confirmed: true,
      expiresAt: null,
    });
    expect(await bubbles.getLocation(u.id)).toEqual({ lat: 35.9095, lng: -79.0469 });

    location = null; // not sharing
    clock = new Date(clock.getTime() + 10 * 60_000);
    const center = await bubbles.getLocation(u.id);
    expect(center).not.toBeNull();
    expect(center!.lat).toBeGreaterThan(35.85);
    expect(center!.lat).toBeLessThan(35.95);

    locationDelay = 400; // slower than the budget
    location = { lat: 1, lng: 2, capturedAt: null };
    clock = new Date(clock.getTime() + 10 * 60_000);
    const t0 = performance.now();
    await bubbles.getLocation(u.id);
    expect(performance.now() - t0).toBeLessThan(300);
  });

  it('filters free/busy to the asked range', async () => {
    const u = await onboarded('Ray', '+19195550203');
    busy = [
      { start: '2026-10-10T20:00:00.000Z', end: '2026-10-10T21:00:00.000Z' },
      { start: '2026-10-11T01:00:00.000Z', end: '2026-10-11T02:00:00.000Z' },
    ];
    const got = await bubbles.getFreeBusy(u.id, {
      start: '2026-10-10T22:00:00.000Z',
      end: '2026-10-11T04:00:00.000Z',
    });
    expect(got).toEqual([{ start: '2026-10-11T01:00:00.000Z', end: '2026-10-11T02:00:00.000Z' }]);
  });

  it('learns in the background without blocking, and asks before confirming a hard fact', async () => {
    const u = await onboarded('Sky', '+19195550204');
    const t0 = performance.now();
    const res = await dm(u, "btw I'm allergic to shellfish");
    expect(performance.now() - t0).toBeLessThan(25); // the 30 ms extractor runs after return
    expect(res.handled).toBe(false);

    await bubbles.learner.idle();
    const allergy = (await bubbles.getHardLimits(u.id)).find((f) => f.type === 'allergy');
    expect(allergy).toMatchObject({ value: 'shellfish', confirmed: false, source: 'chat' });
    expect(lastTo(u.id)).toBe(
      "Noticed you're allergic to shellfish. Should I treat that as a hard rule for plans? (yes/no)",
    );
    await dm(u, 'yes');
    expect(lastTo(u.id)).toBe('Locked in.');
    expect(bubbles.facts.get(allergy!.id)?.confirmed).toBe(true);
  });

  it('turns "broke till Friday" into a temporary budget and skips small talk', async () => {
    const u = await onboarded('Tay', '+19195550205');
    const lines = ['lol', 'ok see you', 'broke till friday so nothing over $15', 'haha'];
    for (const [i, text] of lines.entries()) {
      bubbles.learn({ messageId: `g${i}`, userId: u.id, text, at: clock.toISOString() });
    }
    await bubbles.learner.idle();
    expect(bubbles.learner.stats).toMatchObject({ skipped: 3, processed: 1 });
    const budget = bubbles.facts.current(u.id, 'budget_max');
    expect(budget).toMatchObject({ value: '15', expiresAt: '2026-10-17T03:59:59.000Z' });
    await dm(u, 'no');
    expect(bubbles.facts.current(u.id, 'budget_max')?.value).toBe('30');
  });

  it('ignores chat facts until onboarding is done', async () => {
    const u = await rt.crews.createUser({ displayName: 'Uma', handle: '+19195550206' });
    bubbles.learn({ messageId: 'x1', userId: u.id, text: "I'm vegan", at: clock.toISOString() });
    await bubbles.learner.idle();
    expect(bubbles.facts.active(u.id)).toHaveLength(0);
  });
});
