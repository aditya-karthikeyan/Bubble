import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@bubbleworks/shared';
import { FakeMessaging } from '@bubbleworks/shared/fakes';
import { bubbleInbox, crewInvites, facts, groupMembers, ledger, users } from '../db/schema.js';
import type { Runtime } from '../runtime.js';
import { testRuntime } from '../test-helpers.js';
import {
  isNoSplit,
  meatLimits,
  RuleExtractor,
  resolveUntil,
  type ExtractedFact,
  type FactExtractor,
} from './extract.js';
import { NO_SPLIT } from './facts.js';
import { DbBubbleService, isNo, isYes, parseCrewDeclaration, toE164 } from './service.js';

/** Rule extraction plus a few canned answers, so tests never call the network. */
class ScriptedExtractor implements FactExtractor {
  private readonly rules = new RuleExtractor();
  calls = 0;
  constructor(private readonly canned: Record<string, ExtractedFact[]> = {}) {}
  async extract(text: string, hint: Parameters<FactExtractor['extract']>[1]) {
    this.calls++;
    return this.canned[text] ?? this.rules.extract(text, hint);
  }
}

const NOW = new Date('2026-10-10T20:00:00.000Z'); // Saturday 16:00 in New York

describe('DbBubbleService', () => {
  let rt: Runtime;
  let messaging: FakeMessaging;
  let bubbles: DbBubbleService;
  let extractor: ScriptedExtractor;
  let clock: Date;
  let seq = 0;
  const changes: Array<{ chatId: string; userId: string; change: string }> = [];

  beforeEach(() => {
    rt = testRuntime();
    messaging = new FakeMessaging({ print: false });
    extractor = new ScriptedExtractor();
    clock = new Date(NOW);
    changes.length = 0;
    bubbles = new DbBubbleService({
      db: rt.db,
      crews: rt.crews,
      messaging,
      extractor,
      calendarLink: (id) => `https://example.test/oauth/google/start?u=${id}`,
      onCrewChanged: async (c) => void changes.push(c),
      now: () => clock,
    });
  });
  afterEach(() => rt.close());

  const newUser = (name: string, phone: string, bubbleNumber = '+16285550100'): Promise<User> =>
    rt.crews.createUser({ displayName: name, handle: phone, bubbleNumber });

  const dm = async (user: User, text: string, messageId = `m${++seq}`) => {
    clock = new Date(clock.getTime() + 5_000);
    return bubbles.onPrivateMessage({ messageId, userId: user.id, text, at: clock.toISOString() });
  };

  const textsTo = (userId: string): string[] =>
    messaging.sent.flatMap((s) =>
      s.kind === 'private_text' && s.input.userId === userId ? [s.input.text] : [],
    );
  const lastTo = (userId: string) => textsTo(userId).at(-1) ?? '';

  async function onboard(user: User, answers: string[] = []): Promise<void> {
    const [diet = 'none', budget = '25', area = 'Franklin St', favs = 'skip', venmo = 'skip'] =
      answers;
    await dm(user, 'hi');
    await dm(user, diet);
    if (/allerg/i.test(diet)) await dm(user, 'yes');
    await dm(user, budget);
    await dm(user, area);
    await dm(user, favs);
    await dm(user, venmo);
  }

  describe('onboarding', () => {
    it('asks five questions and stores the profile', async () => {
      const zoe = await newUser('Zoe', '+19195550101');
      await dm(zoe, 'hey');
      expect(lastTo(zoe.id)).toMatch(/^Hey Zoe, I'm your bubble/);
      expect(lastTo(zoe.id)).toMatch(/1\/5/);
      expect(lastTo(zoe.id)).not.toMatch(/https?:/); // no links in the first message

      await dm(zoe, "vegetarian, and I'm allergic to peanuts");
      expect(lastTo(zoe.id)).toMatch(/allergic to peanut\? \(yes\/no\)/);
      await dm(zoe, 'yes');
      expect(lastTo(zoe.id)).toMatch(/2\/5/);
      await dm(zoe, '$20-30');
      expect(lastTo(zoe.id)).toMatch(/3\/5/);
      await dm(zoe, 'near Franklin St');
      await dm(zoe, 'Alpha Pie and that taco truck');
      await dm(zoe, '@zoe-eats');

      const done = lastTo(zoe.id);
      expect(done).toMatch(/^All set/);
      expect(done).toContain('https://example.test/oauth/google/start?u=');
      expect(done).toContain('send me your location right here (+ → Location → Share)');
      expect(done).toMatch(/my crew is/);

      const profile = await bubbles.getProfile(zoe.id);
      const byType = Object.fromEntries(profile.facts.map((f) => [f.type, f]));
      expect(byType['diet']).toMatchObject({ value: 'vegetarian', hard: true, confirmed: true });
      expect(byType['allergy']).toMatchObject({ value: 'peanut', hard: true, confirmed: true });
      expect(byType['budget_max']).toMatchObject({ value: '30', hard: true });
      expect(byType['neighborhood']?.value).toBe('near Franklin St');
      expect(byType['venmo_handle']?.value).toBe('@zoe-eats');
      const venue = rt.db.query.venues.findFirst({
        where: (v, { eq: e }) => e(v.name, 'Alpha Pie'),
      });
      expect(profile.facts.find((f) => f.type === 'favorite_venue')?.value).toBe((await venue)?.id);
      expect(profile.facts.find((f) => f.type === 'other')?.value).toBe(
        'favorite spot: that taco truck',
      );
      expect(bubbles.isOnboarded(zoe.id)).toBe(true);
      // 8 inbound messages at 5 s each: well under two minutes.
      expect(clock.getTime() - NOW.getTime()).toBeLessThan(120_000);
    });

    it('drops an allergy the person says is wrong', async () => {
      const yan = await newUser('Yan', '+19195550102');
      await dm(yan, 'hi');
      await dm(yan, 'allergic to shellfish');
      await dm(yan, 'maybe?');
      expect(lastTo(yan.id)).toBe('Just yes or no: is that allergy right?');
      await dm(yan, 'no');
      expect(textsTo(yan.id).at(-2)).toBe("Okay, I won't save it.");
      expect(lastTo(yan.id)).toMatch(/2\/5/);
      expect((await bubbles.getHardLimits(yan.id)).some((f) => f.type === 'allergy')).toBe(false);
    });

    it('re-asks the budget once and accepts skip', async () => {
      const xi = await newUser('Xi', '+19195550103');
      await dm(xi, 'hi');
      await dm(xi, 'none');
      await dm(xi, 'whatever works');
      expect(lastTo(xi.id)).toBe('Just a number works, like 25. Or say skip.');
      await dm(xi, 'skip');
      expect(lastTo(xi.id)).toMatch(/3\/5/);
    });

    it('answers a redelivered message once', async () => {
      const wu = await newUser('Wu', '+19195550104');
      await dm(wu, 'hi', 'dup-1');
      const again = await dm(wu, 'hi', 'dup-1');
      expect(again.handled).toBe(true);
      expect(textsTo(wu.id)).toHaveLength(1);
    });

    it('turns a temporary budget into an expiring fact and lets it lapse', async () => {
      const vic = await newUser('Vic', '+19195550105');
      await onboard(vic, ['none', '40']);
      await bubbles.recordFact({
        userId: vic.id,
        type: 'budget_max',
        value: '15',
        hard: true,
        confidence: 0.9,
        source: 'chat',
        confirmed: true,
        expiresAt: resolveUntil('till Friday', clock),
      });
      expect(bubbles.facts.current(vic.id, 'budget_max')?.value).toBe('15');
      clock = new Date('2026-10-17T05:00:00.000Z'); // Saturday 01:00 New York, after Friday
      expect(bubbles.facts.current(vic.id, 'budget_max')?.value).toBe('40');
    });
  });

  describe('crews', () => {
    it('declares a crew, invites by name and number, and activates on the last yes', async () => {
      const ana = await newUser('Ana', '+19195550111');
      const bo = await newUser('Bo', '+19195550112');
      const cy = await newUser('Cy', '+19195550113');
      for (const u of [ana, bo, cy]) await onboard(u);

      await dm(ana, 'my crew is Bo and 919-555-0113 called Thursday Eats');
      expect(lastTo(ana.id)).toMatch(/^Made Thursday Eats\. I asked Bo and Cy to confirm/);

      const invite = lastTo(bo.id);
      expect(invite).toBe(
        'Ana added you to Thursday Eats with Cy. Your bubble plans with theirs and never shares ' +
          'your details. Want in? (yes/no)',
      );

      await dm(bo, 'yes');
      expect(lastTo(bo.id)).toBe("You're in Thursday Eats.");
      await dm(cy, 'yep');
      const crew = (await rt.crews.crewsOf(ana.id)).find((g) => g.name === 'Thursday Eats');
      expect(crew?.status).toBe('active');
      for (const u of [ana, bo, cy]) {
        expect(lastTo(u.id)).toMatch(/^Thursday Eats is set: (Ana|Bo|Cy).*Anyone can text/);
      }
      expect(changes.map((c) => c.change)).toEqual(['joined', 'joined']);
    });

    it('holds an invite until the invitee finishes onboarding', async () => {
      const ana = await newUser('Ana', '+19195550121');
      const dee = await newUser('Dee', '+19195550122');
      await onboard(ana);
      await dm(ana, 'my crew is +19195550122');
      expect(textsTo(dee.id)).toHaveLength(0);

      await onboard(dee);
      expect(lastTo(dee.id)).toMatch(/^Ana added you to Ana's crew\. .*Want in\? \(yes\/no\)$/);
    });

    it('tells the creator who passed, and names people it cannot find', async () => {
      const ana = await newUser('Ana', '+19195550131');
      const eve = await newUser('Eve', '+19195550132');
      await onboard(ana);
      await onboard(eve);
      await dm(ana, 'crew: Eve, Zed');
      expect(lastTo(ana.id)).toMatch(/I couldn't find Zed\. They need a bubble first/);
      await dm(eve, 'nah');
      expect(lastTo(eve.id)).toBe("No worries, you're not in it.");
      expect(lastTo(ana.id)).toBe("Eve passed on Ana's crew.");
      expect(changes).toContainEqual(expect.objectContaining({ userId: eve.id, change: 'left' }));
    });

    it('never puts facts in invites or crew updates', async () => {
      const ana = await newUser('Ana', '+19195550141');
      const fay = await newUser('Fay', '+19195550142');
      await onboard(ana, ['vegan and allergic to sesame', '18', 'Carrboro', 'skip', '@ana-v']);
      await onboard(fay);
      await dm(ana, 'my crew is Fay');
      await dm(fay, 'yes');
      const toFay = textsTo(fay.id).join('\n');
      for (const secret of ['vegan', 'sesame', '$18', 'Carrboro', '@ana-v']) {
        expect(toFay).not.toContain(secret);
      }
    });
  });

  describe('no pork / no beef (P2 real-phone run)', () => {
    it('"no pork or beef" at the diet question saves two hard, confirmed facts', async () => {
      const raj = await newUser('Raj', '+19195550143');
      await onboard(raj, ['no pork or beef']);
      const diets = (await bubbles.getHardLimits(raj.id)).filter((f) => f.type === 'diet');
      expect(diets.map((f) => f.value).sort()).toEqual(['no_beef', 'no_pork']);
      expect(diets.every((f) => f.hard && f.confirmed)).toBe(true);
      expect(textsTo(raj.id).join('\n')).toContain("you don't eat pork");
    });

    it('reads common phrasings without false alarms', () => {
      const read = (t: string) =>
        meatLimits(t)
          .map((f) => f.value)
          .sort()
          .join(',');
      expect(read('no pork or beef')).toBe('no_beef,no_pork');
      expect(read("I don't eat pork")).toBe('no_pork');
      expect(read('no red meat please')).toBe('no_beef,no_pork');
      expect(read('beef-free')).toBe('no_beef');
      expect(read('I love pork')).toBe('');
      expect(read('no, pork is great')).toBe('');
    });
  });

  describe('location pins', () => {
    it('a pin sent in iMessage is saved, used as the location, and expires after 6 hours', async () => {
      const sam = await newUser('Sam', '+19195550144');
      await onboard(sam);
      const pin = { lat: 35.9132, lng: -79.0558 };
      expect(
        await bubbles.onPrivateMessage({
          messageId: 'pin1',
          userId: sam.id,
          text: '',
          at: clock.toISOString(),
          location: pin,
        }),
      ).toEqual({ handled: true });
      expect(lastTo(sam.id)).toMatch(/^Got your location 📍/);
      expect(await bubbles.getLocation(sam.id)).toEqual(pin);
      clock = new Date(clock.getTime() + 7 * 3_600_000);
      expect(await bubbles.getLocation(sam.id)).not.toEqual(pin);
    });

    it('mid-onboarding, a pin repeats the open question', async () => {
      const tia = await newUser('Tia', '+19195550145');
      await dm(tia, 'hi');
      await bubbles.onPrivateMessage({
        messageId: 'pin2',
        userId: tia.id,
        text: '',
        at: clock.toISOString(),
        location: { lat: 35.91, lng: -79.05 },
      });
      expect(lastTo(tia.id)).toMatch(/Got your location[\s\S]*1\/5/);
    });
  });

  describe('opting out of splits', () => {
    it('"I don\'t want to split" at the Venmo question opts out (P2 real-phone run)', async () => {
      const pia = await newUser('Pia', '+19195550141');
      await onboard(pia, ['none', '25', 'Franklin St', 'skip', "I don't want to split"]);
      expect(bubbles.facts.current(pia.id, 'venmo_handle')?.value).toBe(NO_SPLIT);
      expect(textsTo(pia.id).join('\n')).toContain('you pay for yourself, no bill splits');
    });

    it('works anytime after onboarding, and replaces a handle', async () => {
      const quinn = await newUser('Quinn', '+19195550142');
      await onboard(quinn, ['none', '25', 'Franklin St', 'skip', '@quinn-q']);
      expect(await dm(quinn, "I'll pay for myself, no venmo")).toEqual({ handled: true });
      expect(lastTo(quinn.id)).toMatch(/^Got it, you'll pay for yourself\./);
      expect(bubbles.facts.current(quinn.id, 'venmo_handle')?.value).toBe(NO_SPLIT);
    });

    it('reads opt-outs without catching handles or skips', () => {
      for (const t of [
        "I don't want to split",
        'dont split me',
        'no venmo',
        'not splitting',
        'I’d rather not split',
      ])
        expect(isNoSplit(t), t).toBe(true);
      for (const t of ['@pia-p', 'skip', 'split it evenly', 'venmo is @x'])
        expect(isNoSplit(t), t).toBe(false);
    });
  });

  describe('forget', () => {
    it('"forget that" deletes the most recent fact', async () => {
      const gus = await newUser('Gus', '+19195550151');
      await onboard(gus, ['vegetarian', '25', 'Southpoint', 'skip', '@gus']);
      await dm(gus, 'forget that');
      expect(lastTo(gus.id)).toBe('Done, I forgot that your Venmo is @gus.');
      expect(bubbles.facts.current(gus.id, 'venmo_handle')).toBeNull();
      expect(bubbles.facts.current(gus.id, 'diet')?.value).toBe('vegetarian');
    });

    it('"forget me" needs a yes, then leaves no rows behind', async () => {
      const hal = await newUser('Hal', '+19195550161');
      const ivy = await newUser('Ivy', '+19195550162');
      await onboard(hal, ['vegan', '30']);
      await onboard(ivy);
      await dm(ivy, 'my crew is Hal');
      await dm(hal, 'yes');
      rt.db
        .insert(ledger)
        .values({
          id: 'l1',
          groupId: 'group_demo',
          planId: 'p1',
          userId: hal.id,
          kind: 'paid',
          amount: 30,
          note: null,
          at: clock.toISOString(),
        })
        .run();

      await dm(hal, 'forget me');
      expect(lastTo(hal.id)).toMatch(/Reply yes to confirm\.$/);
      await dm(hal, 'yes');
      expect(lastTo(hal.id)).toMatch(/^Done\. Everything I knew about you is gone/);

      const count = (rows: unknown[]) => rows.length;
      expect(count(rt.db.select().from(users).where(eq(users.id, hal.id)).all())).toBe(0);
      expect(count(rt.db.select().from(facts).where(eq(facts.userId, hal.id)).all())).toBe(0);
      expect(count(rt.db.select().from(ledger).where(eq(ledger.userId, hal.id)).all())).toBe(0);
      expect(
        count(rt.db.select().from(groupMembers).where(eq(groupMembers.userId, hal.id)).all()),
      ).toBe(0);
      expect(
        count(rt.db.select().from(crewInvites).where(eq(crewInvites.userId, hal.id)).all()),
      ).toBe(0);
      expect(
        count(rt.db.select().from(bubbleInbox).where(eq(bubbleInbox.userId, hal.id)).all()),
      ).toBe(0);
    });

    it('"forget me" expires and a no keeps everything', async () => {
      const jo = await newUser('Jo', '+19195550171');
      await onboard(jo);
      await dm(jo, 'forget me');
      await dm(jo, 'no');
      expect(lastTo(jo.id)).toBe('Okay, keeping everything.');
      await dm(jo, 'forget me');
      clock = new Date(clock.getTime() + 6 * 60_000);
      await dm(jo, 'yes');
      expect(await rt.crews.userById(jo.id)).not.toBeNull();
    });
  });

  it('hands unknown texts back to the engine once onboarded', async () => {
    const kim = await newUser('Kim', '+19195550181');
    await onboard(kim);
    expect((await dm(kim, 'wait')).handled).toBe(false);
  });
});

describe('helpers', () => {
  it('resolves time phrases in New York time', () => {
    // Saturday 2026-10-10 16:00 New York.
    expect(resolveUntil('till Friday', NOW)).toBe('2026-10-17T03:59:59.000Z');
    expect(resolveUntil('until tomorrow', NOW)).toBe('2026-10-12T03:59:59.000Z');
    expect(resolveUntil('tonight', NOW)).toBe('2026-10-11T03:59:59.000Z');
    expect(resolveUntil('for a while', NOW)).toBe('2026-10-18T03:59:59.000Z');
  });

  it('parses crew declarations', () => {
    expect(parseCrewDeclaration('my crew is Ava, Ben and +1 919 555 0101')).toEqual({
      members: ['Ava', 'Ben', '+1 919 555 0101'],
      name: null,
    });
    expect(parseCrewDeclaration('make a crew with Ava & Ben named Dinner Club')).toEqual({
      members: ['Ava', 'Ben'],
      name: 'Dinner Club',
    });
    expect(parseCrewDeclaration('dinner tonight?')).toBeNull();
  });

  it('reads phones, yes, and no', () => {
    expect(toE164('(919) 555-0101')).toBe('+19195550101');
    expect(toE164('Ava')).toBeNull();
    expect(['yes', 'Yep!', '👍', "i'm in"].every(isYes)).toBe(true);
    expect(['no', 'nah', 'nope.'].every(isNo)).toBe(true);
    expect(isYes('yes but only on fridays')).toBe(false);
  });
});
