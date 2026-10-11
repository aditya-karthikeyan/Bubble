import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId, type BookingSummary } from '@bubbleworks/shared';
import { FakeMessaging } from '@bubbleworks/shared/fakes';
import { RuleExtractor } from '../bubbles/extract.js';
import { DbBubbleService } from '../bubbles/service.js';
import type { LocationFix } from '../bubbles/signals.js';
import { bookings, bubbleState, ledger } from '../db/schema.js';
import type { Runtime } from '../runtime.js';
import { INTENT, testRuntime } from '../test-helpers.js';
import { buildIcs, signBookingToken, verifyBookingToken } from './ics.js';
import { Doers, etaMinutes, type LateNotice } from './index.js';

const ALPHA_PIE = 'venue_osm_n13256222785'; // price level 2, Franklin St
const ALPHA = { lat: 35.9151753, lng: -79.0540312 };
const START = '2026-10-10T23:30:00.000Z'; // 19:30 New York

describe('Doers', () => {
  let rt: Runtime;
  let messaging: FakeMessaging;
  let bubbles: DbBubbleService;
  let doers: Doers;
  let nowMs: number;
  let fixes: Map<string, LocationFix | null>;
  const late: LateNotice[] = [];

  beforeEach(() => {
    nowMs = Date.parse('2026-10-10T22:00:00.000Z'); // 18:00 New York
    rt = testRuntime({ timers: { now: () => nowMs, tickMs: 60_000 } });
    messaging = new FakeMessaging({ print: false });
    fixes = new Map();
    late.length = 0;
    bubbles = new DbBubbleService({
      db: rt.db,
      crews: rt.crews,
      messaging,
      extractor: new RuleExtractor(),
      locations: {
        get: async (phone) => {
          const u = await rt.crews.userByHandle(phone);
          return u ? (fixes.get(u.id) ?? null) : null;
        },
      },
      signalBudgetMs: 200,
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
      linkSecret: 'secret',
      onLate: async (n) => void late.push(n),
      now: () => new Date(nowMs),
    });
  });
  afterEach(() => rt.close());

  /** A locked plan for Ava, Ben, Chloe (in) and Dev (represented) at Alpha Pie, 19:30. */
  function booking(): BookingSummary {
    const plan = rt.plans.create({
      groupId: 'group_demo',
      chatId: 'crew:group_demo',
      intent: INTENT,
      createdByUserId: 'user_ava',
    });
    for (const id of ['user_ava', 'user_ben', 'user_chloe'])
      rt.plans.upsertMember(plan.id, id, 'in');
    rt.plans.upsertMember(plan.id, 'user_dev', 'represented', true);
    rt.plans.setChoice(plan.id, { chosenVenueId: ALPHA_PIE, backupVenueId: null, startAt: START });
    const bookingId = newId('booking');
    const at = new Date(nowMs).toISOString();
    rt.db
      .insert(bookings)
      .values({
        id: bookingId,
        planId: plan.id,
        venueId: ALPHA_PIE,
        status: 'booked',
        partySize: 4,
        startAt: START,
        reservationName: 'Ava',
        confirmationCode: 'BW42',
        idempotencyKey: `k-${bookingId}`,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    const venue = rt.venues().find((v) => v.id === ALPHA_PIE)!;
    return {
      bookingId,
      planId: plan.id,
      chatId: 'crew:group_demo',
      venue,
      startAt: START,
      partySize: 4,
      reservationName: 'Ava',
      confirmationCode: 'BW42',
      members: rt.plans.members(plan.id),
    };
  }

  const dmsTo = (userId: string) =>
    messaging.sent.flatMap((s) =>
      s.kind === 'private_text' && s.input.userId === userId ? [s.input.text] : [],
    );

  describe('Inviter', () => {
    it('DMs each attending member a calendar link that serves a valid .ics', async () => {
      const s = booking();
      const r = await doers.inviter.send({ ...s, idempotencyKey: 'inv' });
      expect(r).toEqual({ ok: true, detail: 'Invites sent to 4' });
      const text = dmsTo('user_dev')[0]!;
      expect(text).toMatch(
        /^Alpha Pie, 7:30 PM, table for 4 under Ava\. Add it to your calendar: /,
      );
      const url = /https:\/\/bw\.test(\/ics\/\S+)/.exec(text)![1]!;

      const app = Fastify();
      doers.registerRoutes(app);
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/calendar');
      expect(res.body).toContain('DTSTART:20261010T233000Z');
      expect(res.body).toContain('SUMMARY:Dinner at Alpha Pie');
      expect(res.body).toContain('Confirmation BW42');
      expect((await app.inject({ method: 'GET', url: '/ics/x.y.ics' })).statusCode).toBe(404);
      await app.close();
    });

    it('signs links and folds long lines', () => {
      const t = signBookingToken('booking_1', 'k');
      expect(verifyBookingToken(t, 'k')).toBe('booking_1');
      expect(verifyBookingToken(t, 'other')).toBeNull();
      const ics = buildIcs({
        uid: 'u',
        start: new Date(START),
        minutes: 90,
        title: 'Dinner',
        location: null,
        description: 'x'.repeat(200),
        now: new Date(START),
      });
      expect(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    });
  });

  describe('Splitter', () => {
    it('rotates the payer by the ledger and sends Venmo links to everyone else', async () => {
      // Ava paid last time, so Ben (next to join) covers.
      rt.db
        .insert(ledger)
        .values({
          id: 'prior',
          groupId: 'group_demo',
          planId: 'old',
          userId: 'user_ava',
          kind: 'paid',
          amount: 120,
          note: null,
          at: '2026-10-01T00:00:00Z',
        })
        .run();
      const s = booking();
      const r = await doers.splitter.send({ ...s, idempotencyKey: 'spl' });
      expect(r).toEqual({ ok: true, detail: 'Ben covers, 3 Venmo links sent' });
      expect(dmsTo('user_ben')[0]).toMatch(
        /^You're covering Alpha Pie this time, about \$120 for 4 \(\$30 each\)/,
      );
      expect(dmsTo('user_chloe')[0]).toBe(
        'Ben is covering Alpha Pie. Your share is about $30: ' +
          'https://venmo.com/?txn=pay&recipients=ben-demo&amount=30&note=Alpha%20Pie%20Oct%2010',
      );
      const rows = rt.db.select().from(ledger).where(eq(ledger.planId, s.planId)).all();
      expect(rows).toMatchObject([{ userId: 'user_ben', kind: 'paid', amount: 120 }]);

      await doers.splitter.send({ ...s, idempotencyKey: 'spl' });
      expect(rt.db.select().from(ledger).where(eq(ledger.planId, s.planId)).all()).toHaveLength(1);
    });
  });

  describe('quiet hours', () => {
    it('holds DMs for someone asleep until they wake, then delivers', async () => {
      rt.db
        .insert(bubbleState)
        .values({
          userId: 'user_dev',
          presence: 'sleep',
          presenceUntil: '2026-10-11T11:00:00.000Z',
          updatedAt: '',
        })
        .run();
      const s = booking();
      await doers.inviter.send({ ...s, idempotencyKey: 'inv' });
      expect(dmsTo('user_dev')).toHaveLength(0);
      expect(dmsTo('user_ava')).toHaveLength(1);

      nowMs = Date.parse('2026-10-11T11:00:01.000Z');
      await rt.timers.tick();
      expect(dmsTo('user_dev')).toHaveLength(1);
    });
  });

  describe('Watcher', () => {
    it('arms 45 minutes before, posts ETAs, and reports a late member once', async () => {
      const s = booking();
      await doers.watcher.start(s);
      const armed = rt.timers.get(`p3:watch:${s.planId}`)!;
      expect(new Date(armed.fireAt).toISOString()).toBe('2026-10-10T22:45:00.000Z');

      nowMs = Date.parse('2026-10-10T23:25:00.000Z'); // 5 minutes before
      fixes.set('user_ava', { ...ALPHA, capturedAt: null }); // already there
      fixes.set('user_ben', { lat: ALPHA.lat + 0.005, lng: ALPHA.lng, capturedAt: null }); // ~550 m
      fixes.set('user_chloe', { lat: ALPHA.lat + 0.12, lng: ALPHA.lng, capturedAt: null }); // ~13 km
      bubbles.prefetchSignals(['user_ava', 'user_ben', 'user_chloe', 'user_dev']);
      await new Promise((r) => setTimeout(r, 20));

      const report = (await doers.watchTick(s.bookingId, s.planId))!;
      const byId = Object.fromEntries(report.members.map((m) => [m.userId, m]));
      expect(byId['user_ava']).toMatchObject({ here: true, etaMin: 0 });
      expect(byId['user_ben']).toMatchObject({ here: false, etaMin: 7 });
      expect(byId['user_chloe']!.minutesLate).toBeGreaterThan(15);
      expect(byId['user_dev']).toMatchObject({ etaMin: null });

      expect(late).toEqual([
        expect.objectContaining({ userId: 'user_chloe', planId: s.planId, bookingId: s.bookingId }),
      ]);
      const card = messaging.sent.filter((x) => x.kind === 'live_card').at(-1);
      expect(card?.kind === 'live_card' && card.input.card.lines).toEqual([
        'Ava: here',
        'Ben: ~7 min away',
        expect.stringMatching(/^Chloe: ~\d+ min away$/),
        'Dev: no location',
      ]);
      expect(
        messaging.sent.some(
          (x) =>
            x.kind === 'group_text' &&
            /^Chloe is about \d+ min behind\. Asking Alpha Pie/.test(x.input.text),
        ),
      ).toBe(true);

      nowMs += 60_000;
      await doers.watchTick(s.bookingId, s.planId);
      expect(late).toHaveLength(1); // reported once
      expect(rt.timers.get(`p3:watch:${s.planId}`)?.firedAt).toBeNull(); // next tick scheduled

      await doers.watcher.stop({ planId: s.planId });
      expect(rt.timers.get(`p3:watch:${s.planId}`)).toBeNull();
    });

    it('estimates walking and driving times', () => {
      expect(etaMinutes(400)).toBe(5);
      expect(etaMinutes(8000)).toBe(25);
    });
  });

  describe('absent representation', () => {
    it('sends a represented member a private summary with a veto option, naming only their own limits', async () => {
      const s = booking();
      await bubbles.recordFact({
        userId: 'user_dev',
        type: 'allergy',
        value: 'tree_nut',
        hard: true,
        confidence: 1,
        source: 'onboarding',
        confirmed: true,
        expiresAt: null,
      });
      await rt.bus.publish({
        type: 'plan_locked',
        planId: s.planId,
        at: new Date(nowMs).toISOString(),
        venue: { venueId: ALPHA_PIE, name: 'Alpha Pie', cuisine: 'pizza' },
        backup: null,
        startAt: START,
        partySize: 4,
      });
      await new Promise((r) => setTimeout(r, 10));
      const summary = dmsTo('user_dev');
      expect(summary).toHaveLength(1);
      expect(summary[0]).toMatch(
        /^While you were away, your bubble joined dinner for you: Alpha Pie at 7:30 PM\. I kept to your limits: .*no tree nut.*\. Reply veto/,
      );
      // Ava, Ben, and Chloe are in, not represented: no summary, and no one sees Dev's limits.
      for (const id of ['user_ava', 'user_ben', 'user_chloe']) {
        expect(dmsTo(id).join(' ')).not.toContain('tree nut');
      }
    });
  });
});
