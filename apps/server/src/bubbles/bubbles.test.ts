import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId, type User } from '@bubbleworks/shared';
import { FakeMessaging } from '@bubbleworks/shared/fakes';
import {
  bookings,
  bubbleInbox,
  crewInvites,
  facts,
  groupMembers,
  ledger,
  plans,
  users,
} from '../db/schema.js';
import type { Runtime } from '../runtime.js';
import { INTENT, testRuntime } from '../test-helpers.js';
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
    const [diet = 'none', budget = '25', favs = 'skip', venmo = 'skip'] = answers;
    await dm(user, 'hi');
    await dm(user, diet);
    if (/allerg/i.test(diet)) await dm(user, 'yes');
    await dm(user, budget);
    await dm(user, favs);
    await dm(user, venmo);
  }

  describe('onboarding', () => {
    it('asks five questions and stores the profile', async () => {
      const zoe = await newUser('Zoe', '+19195550101');
      await dm(zoe, 'hey');
      expect(lastTo(zoe.id)).toMatch(/^Hey Zoe, I'm your bubble/);
      expect(lastTo(zoe.id)).toMatch(/1\/4/);
      expect(lastTo(zoe.id)).not.toMatch(/https?:/); // no links in the first message

      await dm(zoe, "vegetarian, and I'm allergic to peanuts");
      expect(lastTo(zoe.id)).toMatch(/allergic to peanut\? \(yes\/no\)/);
      await dm(zoe, 'yes');
      expect(lastTo(zoe.id)).toMatch(/2\/4/);
      await dm(zoe, '$20-30');
      expect(lastTo(zoe.id)).toMatch(/3\/4/);
      await dm(zoe, 'Alpha Pie and that taco truck');
      await dm(zoe, '@zoe-eats');

      const done = lastTo(zoe.id);
      expect(done).toMatch(/^All set/);
      expect(done).toContain('https://example.test/oauth/google/start?u=');
      expect(done).toContain(
        'send me a pin here (+ → Location → Send My Current Location; "Share My Location" does not reach me)',
      );
      expect(done).toContain('Your crew never sees where you are.');
      expect(done).toContain("if you're running late I'll ask the restaurant to hold your table");
      expect(done).toMatch(/new crew/);

      const profile = await bubbles.getProfile(zoe.id);
      const byType = Object.fromEntries(profile.facts.map((f) => [f.type, f]));
      expect(byType['diet']).toMatchObject({ value: 'vegetarian', hard: true, confirmed: true });
      expect(byType['allergy']).toMatchObject({ value: 'peanut', hard: true, confirmed: true });
      expect(byType['budget_max']).toMatchObject({ value: '30', hard: true });
      expect(byType['payment_handle']?.value).toBe('venmo:@zoe-eats');
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
      expect(lastTo(yan.id)).toMatch(/2\/4/);
      expect((await bubbles.getHardLimits(yan.id)).some((f) => f.type === 'allergy')).toBe(false);
    });

    it('re-asks the budget once and accepts skip', async () => {
      const xi = await newUser('Xi', '+19195550103');
      await dm(xi, 'hi');
      await dm(xi, 'none');
      await dm(xi, 'whatever works');
      expect(lastTo(xi.id)).toBe('Just a number works, like 25. Or say skip.');
      await dm(xi, 'skip');
      expect(lastTo(xi.id)).toMatch(/3\/4/);
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

    it('"new crew" makes a crew of one with a join code, and "join <code>" lands a friend in it', async () => {
      const ana = await newUser('Ana', '+19195550141');
      const bo = await newUser('Bo', '+19195550142');
      for (const u of [ana, bo]) await onboard(u);

      await dm(ana, 'new crew the boys');
      const made = lastTo(ana.id);
      expect(made).toMatch(/^the boys is set 🫧/);
      const crew = (await rt.crews.crewsOf(ana.id)).find((g) => g.name === 'the boys')!;
      expect(crew.status).toBe('active');
      expect(crew.joinCode).toMatch(/^the-boys-\d{4}$/);
      expect(made).toContain(crew.joinCode!);

      await dm(bo, `join ${crew.joinCode}`);
      expect(lastTo(bo.id)).toMatch(/^You're in the boys 🫧/);
      expect(lastTo(ana.id)).toBe('Bo joined the boys.');
      expect((await rt.crews.membersOf(crew.id)).map((u) => u.displayName).sort()).toEqual([
        'Ana',
        'Bo',
      ]);
      expect((await rt.crews.crewById(crew.id))?.status).toBe('active');

      await dm(bo, 'join nope-0000');
      expect(lastTo(bo.id)).toMatch(/^I don't know that code/);
    });

    it('greet: the bubble texts first once, naming the crew, and the reply answers question 1', async () => {
      const eve = await newUser('Eve', '+19195550151');
      expect(await bubbles.greet(eve.id, { crewName: 'the boys' })).toBe(true);
      expect(textsTo(eve.id)).toHaveLength(1);
      expect(lastTo(eve.id)).toBe(
        "Hey Eve, I'm your bubble 🫧 You're in the boys. Four quick questions so I can plan " +
          "around you.\n\n1/4 Anything you don't eat? Diet, allergies, halal, kosher, or just say none.",
      );
      // Once per person: a second greet and a later "hi bubble" never restart onboarding.
      expect(await bubbles.greet(eve.id)).toBe(false);
      expect(textsTo(eve.id)).toHaveLength(1);
      await dm(eve, 'hi bubble');
      expect(lastTo(eve.id)).toMatch(/^Hey 🫧 1\/4 Anything you don't eat/);
      expect(lastTo(eve.id)).not.toMatch(/I'm your bubble/);
      await dm(eve, 'vegetarian');
      expect(lastTo(eve.id)).toMatch(/^2\/4/);
      const diet = (await bubbles.getProfile(eve.id)).facts.find((f) => f.type === 'diet');
      expect(diet?.value).toBe('vegetarian');
    });

    it('welcome after a join: a new member hears "You\'re in", the creator hears who joined', async () => {
      const ana = await newUser('Ana', '+19195550152');
      const bo = await newUser('Bo', '+19195550153');
      const cy = await newUser('Cy', '+19195550154');
      await onboard(ana);
      await onboard(bo);
      await dm(ana, 'new crew the boys');
      const crew = (await rt.crews.crewsOf(ana.id)).find((g) => g.name === 'the boys')!;

      // Bo already has a bubble: straight in.
      const joined = await bubbles.addToCrew(bo.id, crew);
      expect(joined.newMember).toBe(true);
      await bubbles.welcome(bo.id, { crewId: crew.id, newMember: true });
      expect(lastTo(bo.id)).toMatch(/^You're in the boys 🫧 Anyone in it can text me/);
      expect(lastTo(ana.id)).toBe('Bo joined the boys.');
      expect(changes.at(-1)).toMatchObject({ userId: bo.id, change: 'joined' });
      expect((await bubbles.addToCrew(bo.id, crew)).newMember).toBe(false);

      // Cy never texted: the onboarding welcome carries the crew.
      await bubbles.addToCrew(cy.id, crew);
      await bubbles.welcome(cy.id, { crewId: crew.id, newMember: true });
      expect(textsTo(cy.id)).toHaveLength(1);
      expect(lastTo(cy.id)).toMatch(/^Hey Cy, I'm your bubble 🫧 You're in the boys\./);
      expect(lastTo(ana.id)).toBe('Cy joined the boys.');
    });

    it('a plan-shaped text from someone with no crew points them at "new crew"', async () => {
      const dee = await newUser('Dee', '+19195550143');
      await onboard(dee);
      await dm(dee, 'dinner tonight?');
      expect(lastTo(dee.id)).toMatch(/^You're not in a crew yet/);
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

  describe('fixing an onboarding answer', () => {
    const diets = async (id: string) =>
      (await bubbles.getHardLimits(id)).filter((f) => f.type === 'diet').map((f) => f.value);

    it('"I messed up" at 2/4 re-asks 1/4, swaps the answer, and picks up at 2/4', async () => {
      const vic = await newUser('Vic', '+19195550147');
      await dm(vic, 'hi');
      await dm(vic, 'vegetarian'); // meant vegan
      expect(lastTo(vic.id)).toMatch(/2\/4/);
      await dm(vic, 'wait i messed up');
      expect(lastTo(vic.id)).toMatch(
        /^No problem, let's redo that one\.\n\nAnything you don't eat/,
      );
      await dm(vic, 'vegan');
      const [updated, next] = textsTo(vic.id).slice(-2);
      expect(updated).toBe('Updated: you eat vegan.');
      expect(next).toMatch(/^2\/4/);
      expect(await diets(vic.id)).toEqual(['vegan']);
      await dm(vic, '30');
      expect(lastTo(vic.id)).toMatch(/^3\/4/);
    });

    it('"oops I meant ..." redoes the last answer in one message', async () => {
      const wen = await newUser('Wen', '+19195550148');
      await dm(wen, 'hi');
      await dm(wen, 'vegetarian');
      await dm(wen, 'oops I meant pescatarian');
      expect(textsTo(wen.id).at(-2)).toBe('Updated: you eat pescatarian.');
      expect(lastTo(wen.id)).toMatch(/^2\/4/);
      expect(await diets(wen.id)).toEqual(['pescatarian']);
    });

    it('an edited message replaces the answer it gave', async () => {
      const xan = await newUser('Xan', '+19195550149');
      await dm(xan, 'hi');
      await dm(xan, 'vegetarian', 'orig-1');
      await dm(xan, '25');
      expect(lastTo(xan.id)).toMatch(/^3\/4/);
      expect(
        await bubbles.onPrivateMessage({
          messageId: 'orig-1:edit:1',
          userId: xan.id,
          text: 'vegan, allergic to peanuts',
          at: clock.toISOString(),
          editOf: 'orig-1',
        }),
      ).toEqual({ handled: true });
      expect(textsTo(xan.id).at(-2)).toMatch(/^Saw your edit\. Updated: you eat vegan/);
      expect(lastTo(xan.id)).toMatch(/you're allergic to peanut\? \(yes\/no\)/);
      await dm(xan, 'yes');
      expect(lastTo(xan.id)).toMatch(/^3\/4/); // still where they were
      expect(await diets(xan.id)).toEqual(['vegan']);
    });

    it('"change my budget" works after onboarding too', async () => {
      const yve = await newUser('Yve', '+19195550150');
      await onboard(yve, ['none', '25']);
      await dm(yve, 'change my budget');
      expect(lastTo(yve.id)).toMatch(/Usual budget per person/);
      await dm(yve, 'forty');
      expect(lastTo(yve.id)).toBe('Just a number works, like 25. Or say skip.');
      await dm(yve, '40');
      expect(lastTo(yve.id)).toBe('Updated: your budget is up to $40 a person.');
      expect(bubbles.facts.current(yve.id, 'budget_max')?.value).toBe('40');
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
      expect(lastTo(tia.id)).toMatch(/Got your location[\s\S]*1\/4/);
    });
  });

  describe('opting out of splits', () => {
    it('"I don\'t want to split" at the Venmo question opts out (P2 real-phone run)', async () => {
      const pia = await newUser('Pia', '+19195550141');
      await onboard(pia, ['none', '25', 'skip', "I don't want to split"]);
      expect(bubbles.facts.current(pia.id, 'venmo_handle')?.value).toBe(NO_SPLIT);
      expect(textsTo(pia.id).join('\n')).toContain('you pay for yourself, no bill splits');
    });

    it('takes any payment method at 4/4 and in DMs; a handle undoes an opt-out', async () => {
      const uma = await newUser('Uma', '+19195550146');
      await onboard(uma, ['none', '25', 'skip', '$umacash or 919-555-0177']);
      expect(
        bubbles
          .payHandles(uma.id)
          .map((h) => `${h.method}:${h.id}`)
          .sort(),
      ).toEqual(['cashapp:$umacash', 'zelle:+19195550177']);
      await dm(uma, "I don't want to split");
      expect(bubbles.payHandles(uma.id)).toEqual([]);
      await dm(uma, 'my venmo is @uma-v');
      expect(lastTo(uma.id)).toMatch(/^Saved Venmo @uma-v\./);
      expect(bubbles.optedOutOfSplits(uma.id)).toBe(false);
      expect(
        bubbles
          .payHandles(uma.id)
          .map((h) => h.method)
          .sort(),
      ).toEqual(['cashapp', 'venmo', 'zelle']);
    });

    it('works anytime after onboarding, and replaces a handle', async () => {
      const quinn = await newUser('Quinn', '+19195550142');
      await onboard(quinn, ['none', '25', 'skip', '@quinn-q']);
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
      await onboard(gus, ['vegetarian', '25', 'skip', '@gus']);
      await dm(gus, 'forget that');
      expect(lastTo(gus.id)).toBe('Done, I forgot that friends pay you on Venmo @gus.');
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

  describe('splitting the bill after dinner', () => {
    const ALPHA_PIE = 'venue_osm_n13256222785';

    /** A BOOKED plan at Alpha Pie with everyone in, the table at `startAt` (default 2 h ago). */
    function bookedDinner(people: User[], startAt = '2026-10-10T18:00:00.000Z'): string {
      const plan = rt.plans.create({
        groupId: 'group_demo',
        chatId: 'crew:group_demo',
        intent: INTENT,
        createdByUserId: people[0]!.id,
      });
      for (const u of people) rt.plans.upsertMember(plan.id, u.id, 'in');
      rt.plans.setChoice(plan.id, { chosenVenueId: ALPHA_PIE, backupVenueId: null, startAt });
      rt.db.update(plans).set({ state: 'BOOKED' }).where(eq(plans.id, plan.id)).run();
      const bookingId = newId('booking');
      const madeAt = new Date(Date.parse(startAt) - 3 * 3_600_000).toISOString();
      rt.db
        .insert(bookings)
        .values({
          id: bookingId,
          planId: plan.id,
          venueId: ALPHA_PIE,
          status: 'booked',
          partySize: people.length,
          startAt,
          reservationName: people[0]!.displayName,
          idempotencyKey: `k-${bookingId}`,
          createdAt: madeAt,
          updatedAt: madeAt,
        })
        .run();
      return plan.id;
    }

    type Row = { userId: string; kind: string; amount: number };
    const byKindUser = (rows: Row[]) =>
      [...rows].sort((a, b) => a.kind.localeCompare(b.kind) || a.userId.localeCompare(b.userId));
    const ledgerOf = (planId: string) =>
      byKindUser(
        rt.db
          .select()
          .from(ledger)
          .where(eq(ledger.planId, planId))
          .all()
          .filter((r) => r.kind === 'paid' || r.kind === 'owes')
          .map((r) => ({ userId: r.userId, kind: r.kind, amount: r.amount })),
      );

    it('amount in the message: everyone else gets their share and the Venmo link', async () => {
      const zoe = await newUser('Zoe', '+19195550201');
      const yan = await newUser('Yan', '+19195550202');
      const xi = await newUser('Xi', '+19195550203');
      const wen = await newUser('Wen', '+19195550204');
      await onboard(zoe, ['none', '25', 'skip', '@zoe-eats']);
      await onboard(yan, ['vegetarian', '40', 'skip', '@yan-y']);
      await onboard(xi);
      await onboard(wen, ['none', '25', 'skip', "I don't want to split"]);
      const planId = bookedDinner([zoe, yan, xi, wen]);

      expect(bubbles.claimsDm(zoe.id, 'I covered dinner, it was $84.50')).toBe(true);
      const sentBefore = messaging.sent.length;
      expect(
        await dm(zoe, 'hey I covered dinner, it was $84.50. can you let them know to pay me'),
      ).toEqual({ handled: true });

      // $84.50 over 4 is $21.125: rounded up to $21.13 so Zoe is never short.
      const share =
        'Zoe covered Alpha Pie. Your share is $21.13. Pay them on Venmo: ' +
        'https://venmo.com/?txn=pay&recipients=zoe-eats&amount=21.13&note=Alpha%20Pie';
      expect(lastTo(yan.id)).toBe(share);
      expect(lastTo(xi.id)).toBe(share);
      expect(textsTo(wen.id).some((t) => t.includes('covered'))).toBe(false);
      expect(lastTo(zoe.id)).toBe(
        'Told Yan and Xi to send you $21.13 each (Venmo). ' +
          'Wen turned off split requests, so settle up with them directly ($21.13).',
      );
      // One DM to each of Yan and Xi, one reply to Zoe; nothing else, and no one's facts.
      const fresh = messaging.sent.slice(sentBefore);
      expect(fresh).toHaveLength(3);
      for (const f of fresh) {
        const text = f.kind === 'private_text' ? f.input.text : '';
        expect(text).not.toMatch(/vegetarian|yan-y|\$40|\$25/);
      }

      expect(ledgerOf(planId)).toEqual(
        byKindUser([
          { userId: xi.id, kind: 'owes', amount: 21.13 },
          { userId: yan.id, kind: 'owes', amount: 21.13 },
          { userId: zoe.id, kind: 'paid', amount: 84.5 },
        ]),
      );
    });

    it('amount missing: asks how much, then the next message completes the split', async () => {
      const zoe = await newUser('Zoe', '+19195550211');
      const yan = await newUser('Yan', '+19195550212');
      await onboard(zoe, ['none', '25', 'skip', '@zoe-eats']);
      await onboard(yan);
      const planId = bookedDinner([zoe, yan]);

      await dm(zoe, 'I covered this one, can you tell them to pay me');
      expect(lastTo(zoe.id)).toBe('Fasho 🫧 How much was it all in, tip included?');
      expect(bubbles.claimsDm(zoe.id, '60')).toBe(true);
      await dm(zoe, 'hmm let me check');
      expect(lastTo(zoe.id)).toBe(
        'How much was it all in? Just the number, like $84. Or say never mind.',
      );
      await dm(zoe, '60');
      expect(lastTo(yan.id)).toBe(
        'Zoe covered Alpha Pie. Your share is $30. Pay them on Venmo: ' +
          'https://venmo.com/?txn=pay&recipients=zoe-eats&amount=30&note=Alpha%20Pie',
      );
      expect(lastTo(zoe.id)).toBe('Told Yan to send you $30 each (Venmo).');
      expect(ledgerOf(planId)).toEqual([
        { userId: yan.id, kind: 'owes', amount: 30 },
        { userId: zoe.id, kind: 'paid', amount: 60 },
      ]);
      expect(bubbles.claimsDm(zoe.id, '60')).toBe(false);
    });

    it('"never mind" cancels, and a payer with no handle is asked for one first', async () => {
      const xi = await newUser('Xi', '+19195550221');
      const yan = await newUser('Yan', '+19195550222');
      await onboard(xi); // skipped the payment question
      await onboard(yan);
      bookedDinner([xi, yan]);

      await dm(xi, 'i paid');
      await dm(xi, 'never mind');
      expect(lastTo(xi.id)).toBe('Okay, no split.');
      expect(textsTo(yan.id).some((t) => t.includes('covered'))).toBe(false);

      await dm(xi, 'i got the bill, 90 bucks');
      expect(lastTo(xi.id)).toBe('How should they pay you? Venmo/Cash App/Zelle handle');
      await dm(xi, '$xicash');
      expect(bubbles.payHandles(xi.id)).toEqual([{ method: 'cashapp', id: '$xicash' }]);
      expect(lastTo(yan.id)).toBe(
        'Xi covered Alpha Pie. Your share is $45. Pay them on Cash App: https://cash.app/$xicash/45',
      );
      expect(lastTo(xi.id)).toBe('Told Yan to send you $45 each (Cash App).');
    });

    it('no recent booking: says so and splits nothing', async () => {
      const zoe = await newUser('Zoe', '+19195550231');
      const yan = await newUser('Yan', '+19195550232');
      await onboard(zoe, ['none', '25', 'skip', '@zoe-eats']);
      await onboard(yan);
      await dm(zoe, 'I paid, it was $50');
      expect(lastTo(zoe.id)).toBe("I don't see a recent dinner to split. Which one?");

      // Two days ago is too long ago.
      const planId = bookedDinner([zoe, yan], '2026-10-08T23:00:00.000Z');
      await dm(zoe, 'they owe me $50');
      expect(lastTo(zoe.id)).toBe("I don't see a recent dinner to split. Which one?");
      expect(textsTo(yan.id).some((t) => t.includes('covered'))).toBe(false);
      expect(ledgerOf(planId)).toEqual([]);
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
