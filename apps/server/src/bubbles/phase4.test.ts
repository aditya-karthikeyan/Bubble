import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId, type User } from '@bubbleworks/shared';
import { FakeMessaging } from '@bubbleworks/shared/fakes';
import { asks, bookings, crewInvites, plans, votes } from '../db/schema.js';
import { Doers } from '../doers/index.js';
import type { Runtime } from '../runtime.js';
import { INTENT, testRuntime } from '../test-helpers.js';
import { RuleExtractor } from './extract.js';
import { RuleReactionClassifier } from './reactions.js';
import { seedDemoBubbles } from './seed.js';
import { DbBubbleService, FALLBACK_TEXT } from './service.js';

const ALPHA_PIE = 'venue_osm_n13256222785'; // pizza, price level 2

describe('Phase 4', () => {
  let rt: Runtime;
  let messaging: FakeMessaging;
  let bubbles: DbBubbleService;
  let doers: Doers;
  let nowMs: number;
  let seq = 0;
  const changes: Array<{ chatId: string; userId: string; change: string }> = [];

  beforeEach(() => {
    nowMs = Date.parse('2026-10-10T22:00:00.000Z');
    rt = testRuntime({ timers: { now: () => nowMs } });
    messaging = new FakeMessaging({ print: false });
    changes.length = 0;
    bubbles = new DbBubbleService({
      db: rt.db,
      crews: rt.crews,
      messaging,
      extractor: new RuleExtractor(),
      reactions: new RuleReactionClassifier(),
      locations: { get: async () => null },
      onCrewChanged: async (c) => void changes.push(c),
      now: () => new Date(nowMs),
    });
    doers = new Doers({
      db: rt.db,
      crews: rt.crews,
      bubbles,
      messaging,
      timers: rt.timers,
      bus: rt.bus,
      publicBaseUrl: 'https://bw.test',
      linkSecret: 's',
      now: () => new Date(nowMs),
    });
    seedDemoBubbles(rt.db, new Date(nowMs));
  });
  afterEach(() => rt.close());

  const dm = (userId: string, text: string) =>
    bubbles.onPrivateMessage({
      messageId: `p4-${++seq}`,
      userId,
      text,
      at: new Date(nowMs).toISOString(),
    });
  const textsTo = (userId: string) =>
    messaging.sent.flatMap((s) =>
      s.kind === 'private_text' && s.input.userId === userId ? [s.input.text] : [],
    );

  /** Ava organizes; Ava, Ben, Chloe vote; Chloe accepted a concession; Alpha Pie (pizza) wins. */
  function bookedPlan(startAt = '2026-10-10T23:30:00.000Z'): { planId: string; bookingId: string } {
    const plan = rt.plans.create({
      groupId: 'group_demo',
      chatId: 'crew:group_demo',
      intent: INTENT,
      createdByUserId: 'user_ava',
    });
    for (const id of ['user_ava', 'user_ben', 'user_chloe'])
      rt.plans.upsertMember(plan.id, id, 'in');
    rt.plans.upsertMember(plan.id, 'user_dev', 'represented', true);
    rt.plans.setChoice(plan.id, { chosenVenueId: ALPHA_PIE, backupVenueId: null, startAt });
    rt.db.update(plans).set({ state: 'BOOKED' }).where(eq(plans.id, plan.id)).run();
    const at = new Date(nowMs).toISOString();
    for (const [userId, choice] of [
      ['user_ava', 'thai'],
      ['user_ben', 'pizza'],
      ['user_chloe', 'mediterranean'],
    ] as const) {
      rt.db
        .insert(votes)
        .values({
          id: newId('vote'),
          planId: plan.id,
          pollId: `poll-${plan.id}`,
          kind: 'cuisine',
          userId,
          choice,
          at,
        })
        .run();
    }
    rt.db
      .insert(asks)
      .values({
        id: newId('ask'),
        planId: plan.id,
        userId: 'user_chloe',
        kind: 'budget',
        concession: { factType: 'budget_max', from: '20', to: '30', cost: 3 },
        text: 'internal',
        status: 'accepted',
        idempotencyKey: `ask-${plan.id}`,
        sentAt: at,
        expiresAt: at,
      })
      .run();
    const bookingId = newId('booking');
    rt.db
      .insert(bookings)
      .values({
        id: bookingId,
        planId: plan.id,
        venueId: ALPHA_PIE,
        status: 'booked',
        partySize: 4,
        startAt,
        reservationName: 'Ava',
        idempotencyKey: `b-${bookingId}`,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    return { planId: plan.id, bookingId };
  }

  describe('ledger', () => {
    it('records compromise, preference, organizer, and absence once per booked plan', async () => {
      const before = (await bubbles.getProfile('user_chloe')).recentCompromiseCount;
      const { planId, bookingId } = bookedPlan();
      await rt.bus.publish({
        type: 'booking_confirmed',
        planId,
        at: new Date(nowMs).toISOString(),
        bookingId,
        venue: { venueId: ALPHA_PIE, name: 'Alpha Pie', cuisine: 'pizza' },
        startAt: '2026-10-10T23:30:00.000Z',
        partySize: 4,
        reservationName: 'Ava',
      });
      await new Promise((r) => setTimeout(r, 10));
      const rows = doers.ledger.recordPlan(planId); // second write is a no-op
      expect(rows).toEqual(
        expect.arrayContaining([
          { userId: 'user_ava', kind: 'organized', amount: 1, note: null },
          { userId: 'user_ava', kind: 'compromised', amount: 1, note: 'top choice lost' },
          { userId: 'user_ben', kind: 'got_preference', amount: 1, note: 'pizza' },
          {
            userId: 'user_chloe',
            kind: 'compromised',
            amount: 4,
            note: 'accepted a concession; top choice lost',
          },
          { userId: 'user_dev', kind: 'absent', amount: 1, note: null },
        ]),
      );
      const count = rt.db.all<{ n: number }>(
        sql`select count(*) as n from ledger where plan_id = ${planId}`,
      )[0]!.n;
      expect(count).toBe(5);
      expect((await bubbles.getProfile('user_chloe')).recentCompromiseCount).toBe(before + 1);
    });
  });

  describe('reactions', () => {
    it('"that place was mid" lowers the venue and cuisine; "so good" raises it', async () => {
      bookedPlan('2026-10-10T20:00:00.000Z'); // dinner two hours ago
      await bubbles.recordFact({
        userId: 'user_ben',
        type: 'cuisine_like',
        value: 'pizza',
        hard: false,
        confidence: 0.5,
        source: 'chat',
        confirmed: false,
        expiresAt: null,
      });
      expect(
        await bubbles.reactTo({
          messageId: 'r1',
          userId: 'user_ben',
          text: 'that place was mid',
          at: '',
        }),
      ).toBe('lowered Alpha Pie and pizza');
      const ben = bubbles.facts.active('user_ben');
      expect(ben.some((f) => f.type === 'cuisine_like' && f.value === 'pizza')).toBe(false);
      expect(ben.some((f) => f.type === 'cuisine_avoid' && f.value === 'pizza')).toBe(true);
      expect(ben.some((f) => f.value === `avoid_venue:${ALPHA_PIE}`)).toBe(true);

      // Ava's seeded favorite is Alpha Pie: a negative drops it, a positive brings it back.
      await bubbles.reactTo({
        messageId: 'r2',
        userId: 'user_ava',
        text: 'honestly that place was mid',
        at: '',
      });
      expect(
        bubbles.facts
          .active('user_ava')
          .some((f) => f.type === 'favorite_venue' && f.value === ALPHA_PIE),
      ).toBe(false);
      await bubbles.reactTo({
        messageId: 'r3',
        userId: 'user_ava',
        text: 'ok the food was so good actually',
        at: '',
      });
      const ava = bubbles.facts.active('user_ava');
      expect(ava.some((f) => f.type === 'favorite_venue' && f.value === ALPHA_PIE)).toBe(true);
      expect(ava.some((f) => f.value === `avoid_venue:${ALPHA_PIE}`)).toBe(false);
    });

    it('ignores verdicts long after dinner and from people who were not there', async () => {
      bookedPlan('2026-10-09T20:00:00.000Z'); // 26 hours ago
      expect(
        await bubbles.reactTo({
          messageId: 'r4',
          userId: 'user_ben',
          text: 'that was mid',
          at: '',
        }),
      ).toBeNull();
      bookedPlan('2026-10-10T20:00:00.000Z');
      expect(
        await bubbles.reactTo({
          messageId: 'r5',
          userId: 'user_eli',
          text: 'that was mid',
          at: '',
        }),
      ).toBeNull();
    });
  });

  describe('late joiner', () => {
    it('asks at most two questions, then joins the crew and the live plan', async () => {
      const plan = rt.plans.create({
        groupId: 'group_demo',
        chatId: 'crew:group_demo',
        intent: INTENT,
        createdByUserId: 'user_ava',
      });
      rt.db.update(plans).set({ state: 'GATHERING' }).where(eq(plans.id, plan.id)).run();
      const fay = await rt.crews.createUser({ displayName: 'Fay', handle: '+19195550401' });
      await rt.crews.addMember('group_demo', fay.id);
      rt.db
        .insert(crewInvites)
        .values({
          groupId: 'group_demo',
          userId: fay.id,
          invitedByUserId: 'user_ava',
          status: 'waiting',
          sentAt: null,
          createdAt: new Date(nowMs).toISOString(),
        })
        .run();

      await dm(fay.id, 'hi');
      expect(textsTo(fay.id)[0]).toMatch(
        /Your crew is planning food right now, so two quick questions/,
      );
      expect(textsTo(fay.id)[0]).toMatch(/1\/2 Anything you don't eat/);
      await dm(fay.id, 'vegan');
      expect(textsTo(fay.id).at(-1)).toMatch(/^2\/2 /);
      await dm(fay.id, '20');
      const after = textsTo(fay.id);
      expect(after.at(-2)).toMatch(
        /^You're in ✨ I'll plan around this: you eat vegan; your budget is up to \$20/,
      );
      expect(after.at(-1)).toMatch(/added you to .* Want in\? \(yes\/no\)$/);
      expect(after.filter((t) => /\b\d\/\d\b/.test(t))).toHaveLength(2); // three questions only

      await dm(fay.id, 'yes');
      expect(changes).toContainEqual({
        chatId: 'crew:group_demo',
        userId: fay.id,
        change: 'joined',
      });
    });
  });

  describe('demo seed', () => {
    it('is idempotent and marks the five personas onboarded', () => {
      expect(seedDemoBubbles(rt.db, new Date(nowMs))).toEqual({
        personas: 5,
        favorites: 0,
        ledgerRows: 0,
      });
      for (const id of ['user_ava', 'user_ben', 'user_chloe', 'user_dev', 'user_eli']) {
        expect(bubbles.isOnboarded(id)).toBe(true);
      }
      expect(doers.ledger.summary('group_demo')).toEqual(
        expect.arrayContaining([
          { userId: 'user_ava', paid: 1, compromised: 0, got: 0 },
          { userId: 'user_chloe', paid: 0, compromised: 2, got: 0 },
        ]),
      );
    });
  });

  describe('privacy', () => {
    it("no outbound message to anyone ever carries another member's facts", async () => {
      const secret: Record<string, string[]> = {
        user_ava: ['vegetarian', '$25', 'Franklin St', '@ava-demo'],
        user_ben: ['peanut', '$40', '@ben-demo', 'sushi'],
        // Generic diet words (halal, kosher) appear in the onboarding question itself, so the
        // scan uses values only that person's facts could produce.
        user_chloe: ['$20', '@chloe-demo', 'mediterranean'],
        user_dev: ['$50', 'ramen', 'korean'],
        user_eli: ['wheelchair', '$30', 'thai'],
      };
      // Crew flows, presence, learned facts, and every doer, end to end.
      const gus: User = await rt.crews.createUser({ displayName: 'Gus', handle: '+19195550402' });
      for (const t of [
        'hi',
        'kosher and allergic to sesame',
        'yes',
        '17',
        'Carrboro',
        'skip',
        '@gus-k',
      ]) {
        await dm(gus.id, t);
      }
      secret[gus.id] = ['sesame', '$17', 'Carrboro', '@gus-k'];
      await dm(gus.id, 'my crew is Ava, Ben and Chloe');
      for (const id of ['user_ava', 'user_ben', 'user_chloe']) await dm(id, 'yes');
      await dm('user_dev', 'busy');
      bubbles.learn({
        messageId: 'priv-1',
        userId: 'user_ben',
        text: "I'm allergic to shellfish",
        at: '',
      });
      await bubbles.learner.idle();
      const { planId, bookingId } = bookedPlan();
      const summary = {
        bookingId,
        planId,
        chatId: 'crew:group_demo',
        venue: rt.venues().find((v) => v.id === ALPHA_PIE)!,
        startAt: '2026-10-10T23:30:00.000Z',
        partySize: 4,
        reservationName: 'Ava',
        confirmationCode: null,
        members: rt.plans.members(planId),
      };
      await rt.bus.publish({
        type: 'plan_locked',
        planId,
        at: new Date(nowMs).toISOString(),
        venue: { venueId: ALPHA_PIE, name: 'Alpha Pie', cuisine: 'pizza' },
        backup: null,
        startAt: summary.startAt,
        partySize: 4,
      });
      await new Promise((r) => setTimeout(r, 10));
      await doers.inviter.send({ ...summary, idempotencyKey: 'i' });
      await doers.splitter.send({ ...summary, idempotencyKey: 's' });

      let checked = 0;
      for (const s of messaging.sent) {
        // Onboarding questions and the fallback line are fixed text with examples ("Like $20 or
        // $30", "like I'm vegetarian"), no one's data.
        const fixedQuestion = (t: string) =>
          t === FALLBACK_TEXT || /^(\d\/\d |Hey \w+, I'm your bubble)/.test(t);
        if (s.kind === 'private_text' && !fixedQuestion(s.input.text)) {
          for (const [owner, values] of Object.entries(secret)) {
            if (owner === s.input.userId) continue;
            for (const v of values) {
              // The payer's own Venmo handle is the point of a Venmo link; nothing else may leak.
              if (v.startsWith('@') && s.input.text.includes('venmo.com')) continue;
              // A budget leaks as "up to $30" or "under $30"; a split amount ("$30 each") is not one.
              const forms = v.startsWith('$') ? [`up to ${v}`, `under ${v}`] : [v];
              for (const f of forms) {
                expect(
                  s.input.text,
                  `DM to ${s.input.userId} leaks ${owner}'s "${f}"`,
                ).not.toContain(f);
              }
              checked++;
            }
          }
        }
        if (s.kind === 'group_text' || s.kind === 'live_card') {
          const text = s.kind === 'group_text' ? s.input.text : s.input.card.lines.join(' ');
          for (const values of Object.values(secret))
            for (const v of values) expect(text).not.toContain(v);
        }
      }
      expect(checked).toBeGreaterThan(300); // ~424 message-by-fact checks today
    });

    it('"forget me" leaves no row in any table keyed by that user, including held DMs', async () => {
      const hal = await rt.crews.createUser({ displayName: 'Hal', handle: '+19195550403' });
      for (const t of ['hi', 'vegan', '30', 'skip', '@hal-v']) await dm(hal.id, t);
      await dm(hal.id, 'my crew is Ava');
      await dm('user_ava', 'yes');
      await dm(hal.id, 'sleeping'); // a later DM to Hal is held in a timer
      const { planId, bookingId } = bookedPlan();
      rt.plans.upsertMember(planId, hal.id, 'in');
      await doers.inviter.send({
        bookingId,
        planId,
        chatId: 'crew:group_demo',
        venue: rt.venues().find((v) => v.id === ALPHA_PIE)!,
        startAt: '2026-10-10T23:30:00.000Z',
        partySize: 5,
        reservationName: 'Ava',
        confirmationCode: null,
        members: rt.plans.members(planId),
        idempotencyKey: 'i2',
      });
      expect(rt.timers.pending(`p3dm:${hal.id}`)).toHaveLength(1);

      await dm(hal.id, 'forget me');
      await dm(hal.id, 'yes');

      const tables = rt.db.all<{ name: string }>(
        sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '__drizzle%'`,
      );
      const leftovers: string[] = [];
      for (const { name } of tables) {
        const cols = rt.db
          .all<{ name: string }>(sql.raw(`pragma table_info("${name}")`))
          .map((c) => c.name);
        for (const col of cols.filter((c) => c === 'user_id' || c === 'invited_by_user_id')) {
          const n = rt.db.all<{ n: number }>(
            sql.raw(`select count(*) as n from "${name}" where "${col}" = '${hal.id}'`),
          )[0]!.n;
          if (n) leftovers.push(`${name}.${col}=${n}`);
        }
      }
      const timerMentions = rt.db.all<{ n: number }>(
        sql`select count(*) as n from timers where plan_id = ${`p3dm:${hal.id}`} or payload like ${`%${hal.id}%`}`,
      )[0]!.n;
      expect(leftovers).toEqual([]);
      expect(timerMentions).toBe(0);
      expect(textsTo(hal.id).at(-1)).toMatch(/^Done\. Everything I knew about you is gone/);
    });
  });
});
