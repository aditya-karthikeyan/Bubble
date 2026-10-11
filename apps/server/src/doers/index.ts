/**
 * P3 doers: Inviter, Splitter, Watcher (the DoerPorts), plus absent representation summaries.
 * Owner: P3.
 *
 * - Inviter DMs each attending member a short .ics link (/ics/<signed>.ics).
 * - Splitter stays silent at booking: nobody knows the bill yet. After the meal the person who
 *   paid tells their bubble ("I covered this one"), and the bubble asks the total, DMs everyone
 *   their share with the payer's handle, and writes the paid/owes ledger rows (bubbles/bill.ts).
 * - Watcher wakes 45 minutes before the booking and every 60 s after: reads Find My, estimates
 *   ETAs, updates the live card, and reports anyone 15+ minutes late (once per member).
 * - Representation: when a plan locks, each represented member gets a private summary with a
 *   veto option.
 *
 * Quiet hours: nobody asleep or driving is pinged. Their DMs wait in a durable timer until the
 * presence expires (sleep ends 07:00). Messages carry names, times, and amounts only; never
 * another member's facts.
 */
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  idempotencyKey,
  type BookingSummary,
  type CrewDirectory,
  type DoerPorts,
  type DoerResult,
  type EventBus,
  type MessagingPort,
  type PlanEvent,
  type User,
  type Venue,
} from '@bubbleworks/shared';
import type { DbBubbleService } from '../bubbles/service.js';
import type { Db } from '../db/client.js';
import { bookings, bubbleState, planMembers, plans, timers, venues } from '../db/schema.js';
import { silentLogger, type Logger } from '../events/bus.js';
import type { TimerService } from '../timers/service.js';
import { distanceM } from '../venues/geo.js';
import { buildIcs, signBookingToken, verifyBookingToken } from './ics.js';
import { LedgerWriter } from './ledger.js';

export const WATCH_LEAD_MS = 45 * 60_000;
export const WATCH_EVERY_MS = 60_000;
export const LATE_AFTER_MIN = 15;
/** Lateness beyond this is treated as bad data (stale fix, wrong start), never announced. */
export const MAX_LATE_MIN = 120;
const HERE_WITHIN_M = 150;

export interface LateNotice {
  planId: string;
  bookingId: string;
  userId: string;
  minutesLate: number;
  venueId: string;
  partySize: number;
  startAt: string;
}

export interface DoersDeps {
  db: Db;
  crews: CrewDirectory;
  bubbles: DbBubbleService;
  messaging: Pick<MessagingPort, 'sendPrivateText' | 'sendGroupText' | 'upsertLiveCard'>;
  timers: TimerService;
  bus?: EventBus;
  /** Base URL for the .ics link, e.g. SERVER_PUBLIC_URL. */
  publicBaseUrl: string;
  /** HMAC key for .ics links. */
  linkSecret: string;
  /** Engine handling for lateness: ask the caller to hold the table. */
  onLate?: (notice: LateNotice) => Promise<void>;
  now?: () => Date;
  log?: Logger;
}

type Payload = Record<string, unknown>;

export class Doers implements DoerPorts {
  private readonly now: () => Date;
  private readonly log: Logger;
  /** planId -> userIds already reported late, so the caller is asked once per member. */
  private readonly reportedLate = new Map<string, Set<string>>();

  readonly ledger: LedgerWriter;
  readonly inviter: DoerPorts['inviter'];
  readonly splitter: DoerPorts['splitter'];
  readonly watcher: DoerPorts['watcher'];

  constructor(private readonly d: DoersDeps) {
    this.now = d.now ?? (() => new Date());
    this.log = d.log ?? silentLogger;
    this.inviter = { send: (s) => this.invite(s) };
    this.splitter = { send: (s) => this.split(s) };
    this.watcher = { start: (s) => this.watchStart(s), stop: (s) => this.watchStop(s.planId) };

    d.timers.on('custom', async (t) => {
      const p = t.payload as Payload;
      if (p['p3'] === 'dm') await this.deliverDeferred(p);
      if (p['p3'] === 'watch') await this.watchTick(String(p['bookingId']), t.planId);
    });
    d.bus?.subscribe('*', (e) => this.onEvent(e));
    this.ledger = new LedgerWriter(d.db, { now: this.now, log: this.log });
    if (d.bus) this.ledger.attach(d.bus);
  }

  // -- Inviter ---------------------------------------------------------------

  private async invite(s: BookingSummary & { idempotencyKey: string }): Promise<DoerResult> {
    const token = signBookingToken(s.bookingId, this.d.linkSecret);
    const url = `${this.d.publicBaseUrl}/ics/${token}.ics`;
    const when = clock(s.startAt);
    const people = await this.attending(s);
    const place = s.venue.address ?? s.venue.name;
    const maps = mapsLink(s.venue);
    // The Watcher can only hold the table for people it can find. Anyone it can't locate gets
    // one optional line in this same invite (no extra message); nobody is ever asked again.
    const watched = Date.parse(s.startAt) > this.now().getTime();
    const located = watched
      ? await Promise.all(people.map((u) => this.locatable(u.id)))
      : people.map(() => true);
    for (const [i, u] of people.entries()) {
      await this.dm(
        u,
        `✅ Booked: ${s.venue.name}, ${when}, table for ${people.length} under ${s.reservationName}.\n` +
          `📍 ${place} · ${maps}\n` +
          `Add it to your calendar: ${url}` +
          (located[i] ? '' : `\n${lateNudge(s.venue.name)}`),
        `${s.idempotencyKey}:${u.id}`,
      );
    }
    this.log.info(
      { planId: s.planId, bookingId: s.bookingId, sent: people.length },
      'invites sent',
    );
    return { ok: true, detail: `Invites sent to ${people.length}` };
  }

  /** GET /ics/<token>.ics */
  registerRoutes(app: FastifyInstance): void {
    app.get<{ Params: { token: string } }>('/ics/:token', async (req, reply) => {
      const bookingId = verifyBookingToken(
        req.params.token.replace(/\.ics$/, ''),
        this.d.linkSecret,
      );
      const row = bookingId
        ? this.d.db
            .select({ b: bookings, v: venues })
            .from(bookings)
            .innerJoin(venues, eq(venues.id, bookings.venueId))
            .where(eq(bookings.id, bookingId))
            .get()
        : undefined;
      if (!row) return reply.code(404).send('not found');
      const ics = buildIcs({
        uid: row.b.id,
        start: new Date(row.b.startAt),
        minutes: 90,
        title: `Dinner at ${row.v.name}`,
        location: row.v.address ?? row.v.name,
        description:
          `Table for ${row.b.partySize} under ${row.b.reservationName}.` +
          (row.b.confirmationCode ? ` Confirmation ${row.b.confirmationCode}.` : '') +
          ' Booked by Bubbleworks.',
        now: this.now(),
      });
      return reply
        .header('content-type', 'text/calendar; charset=utf-8')
        .header('content-disposition', `inline; filename="dinner-${row.b.id}.ics"`)
        .send(ics);
    });
  }

  // -- Splitter --------------------------------------------------------------

  /**
   * At booking nobody knows the bill yet, so the Splitter sends nothing. After the meal the
   * person who paid tells their bubble ("I covered this one"), and the bubble asks for the total
   * and DMs everyone their share (DbBubbleService.startBillSplit).
   */
  private async split(s: BookingSummary & { idempotencyKey: string }): Promise<DoerResult> {
    this.log.info({ planId: s.planId, bookingId: s.bookingId }, 'split waits for the payer');
    return { ok: true, detail: 'waiting for the payer' };
  }

  // -- Watcher ---------------------------------------------------------------

  private async watchStart(s: BookingSummary): Promise<void> {
    const startMs = Date.parse(s.startAt);
    const nowMs = this.now().getTime();
    // A booking whose start already passed is bad data (e.g. a default 7 PM picked at 9 PM).
    // Watching it would call everyone hours late, so the Watcher stays off.
    if (!(startMs > nowMs)) {
      this.log.warn(
        { planId: s.planId, startAt: s.startAt },
        'watcher not armed: booking start is in the past',
      );
      return;
    }
    const first = Math.max(nowMs, startMs - WATCH_LEAD_MS);
    this.d.timers.schedule({
      planId: s.planId,
      kind: 'custom',
      id: watchTimerId(s.planId),
      fireAt: first,
      payload: { p3: 'watch', bookingId: s.bookingId },
      replace: true,
    });
    this.log.info({ planId: s.planId, firstTick: new Date(first).toISOString() }, 'watcher armed');
  }

  private async watchStop(planId: string): Promise<void> {
    this.d.db
      .delete(timers)
      .where(eq(timers.id, watchTimerId(planId)))
      .run();
    this.reportedLate.delete(planId);
  }

  /** One Watcher pass. Public for tests and the demo. */
  async watchTick(bookingId: string, planId: string): Promise<WatchReport | null> {
    const row = this.d.db
      .select({ b: bookings, v: venues, p: plans })
      .from(bookings)
      .innerJoin(venues, eq(venues.id, bookings.venueId))
      .innerJoin(plans, eq(plans.id, bookings.planId))
      .where(eq(bookings.id, bookingId))
      .get();
    if (!row || ['CLOSED', 'CANCELLED', 'FAILED'].includes(row.p.state)) return null;
    const nowMs = this.now().getTime();
    const startMs = Date.parse(row.b.startAt);
    const bookedAfterStart = Date.parse(row.b.createdAt) >= startMs;
    if (bookedAfterStart || nowMs > startMs + 30 * 60_000) {
      this.log.warn(
        { planId, bookedAfterStart, startAt: row.b.startAt },
        'watcher stopped: booking start is not ahead of us',
      );
      await this.watchStop(planId);
      return null;
    }
    const venue = { lat: row.v.lat, lng: row.v.lng };
    const members = this.d.db
      .select({ userId: planMembers.userId, status: planMembers.status })
      .from(planMembers)
      .where(eq(planMembers.planId, planId))
      .all()
      .filter((m) => m.status === 'in' || m.status === 'represented');

    this.d.bubbles.prefetchSignals(members.map((m) => m.userId));
    const lines: string[] = [];
    const report: WatchReport = { planId, at: new Date(nowMs).toISOString(), members: [] };
    for (const m of members) {
      const user = await this.d.crews.userById(m.userId);
      const name = user?.displayName ?? 'Someone';
      const fix = (await this.d.bubbles.readLocation(m.userId)).value;
      // The crew sees coarse status only. Minutes and distance are location-derived and stay
      // with the person they describe.
      if (!fix) {
        lines.push(`${name}: no location`);
        report.members.push({ userId: m.userId, etaMin: null, minutesLate: null, here: false });
        continue;
      }
      const meters = distanceM(fix, venue);
      const here = meters <= HERE_WITHIN_M;
      const etaMin = here ? 0 : etaMinutes(meters);
      const minutesLate = Math.round((nowMs + etaMin * 60_000 - startMs) / 60_000);
      const late = !here && minutesLate > LATE_AFTER_MIN;
      lines.push(`${name}: ${here ? 'here' : late ? 'running late' : 'on the way'}`);
      report.members.push({ userId: m.userId, etaMin, minutesLate, here });

      const reported = this.reportedLate.get(planId) ?? new Set<string>();
      if (late && minutesLate > MAX_LATE_MIN) {
        // Hours late is a stale fix or a far-away phone, not a friend stuck in traffic.
        this.log.warn({ planId, userId: m.userId, minutesLate }, 'lateness ignored: implausible');
      } else if (late && !reported.has(m.userId)) {
        reported.add(m.userId);
        this.reportedLate.set(planId, reported);
        this.log.info({ planId, userId: m.userId, minutesLate }, 'member running late');
        await this.d.messaging.sendGroupText({
          chatId: row.p.chatId,
          text: `Someone's running a bit late. I'll ask ${row.v.name} to hold the table.`,
          idempotencyKey: idempotencyKey(planId, 'watcher_late_group'),
        });
        if (user) {
          await this.dm(
            user,
            `Looks like you're about ${etaMin} min out. I'm asking ${row.v.name} to hold the table for you.`,
            idempotencyKey(planId, 'watcher_late_dm', m.userId),
          );
        }
        await this.d.onLate?.({
          planId,
          bookingId,
          userId: m.userId,
          minutesLate,
          venueId: row.v.id,
          partySize: row.b.partySize,
          startAt: row.b.startAt,
        });
      }
    }

    const minsTo = Math.round((startMs - nowMs) / 60_000);
    await this.d.messaging.upsertLiveCard({
      chatId: row.p.chatId,
      planId,
      card: {
        title: `${row.v.name} ${minsTo > 0 ? `in ${minsTo} min` : 'now'}`,
        lines,
      },
      idempotencyKey: idempotencyKey(planId, 'watcher_card', Math.floor(nowMs / WATCH_EVERY_MS)),
    });
    const here = report.members.filter((r) => r.here).length;
    await this.d.bus?.publish({
      type: 'doer_status',
      planId,
      at: new Date(nowMs).toISOString(),
      doer: 'watcher',
      state: 'working',
      detail: `${here} of ${members.length} there`,
    });

    // Keep watching every minute until 30 minutes after the start or everyone is there.
    if (nowMs < startMs + 30 * 60_000 && here < members.length) {
      this.d.timers.schedule({
        planId,
        kind: 'custom',
        id: watchTimerId(planId),
        fireAt: nowMs + WATCH_EVERY_MS,
        payload: { p3: 'watch', bookingId },
        replace: true,
      });
    }
    return report;
  }

  // -- Representation --------------------------------------------------------

  private async onEvent(e: PlanEvent): Promise<void> {
    if (e.type !== 'plan_locked') return;
    const represented = this.d.db
      .select({ userId: planMembers.userId })
      .from(planMembers)
      .where(and(eq(planMembers.planId, e.planId), eq(planMembers.status, 'represented')))
      .all();
    for (const { userId } of represented) {
      const user = await this.d.crews.userById(userId);
      if (!user) continue;
      const limits = (await this.d.bubbles.getHardLimits(userId)).filter((f) => f.confirmed);
      const kept = limits.length
        ? ` I kept to your limits: ${limits.map(limitPhrase).join(', ')}.`
        : '';
      await this.dm(
        user,
        `While you were away, your bubble joined dinner for you: ${e.venue.name} at ${clock(e.startAt)}.${kept} ` +
          "Reply veto if that spot doesn't work, and the crew picks again.",
        idempotencyKey(e.planId, 'represented_summary', userId),
      );
    }
  }

  // -- delivery --------------------------------------------------------------

  /** DM now, or hold it in a durable timer while the person is asleep or driving. */
  private async dm(user: User, text: string, key: string): Promise<void> {
    const presence = await this.d.bubbles.getPresence(user.id);
    if (presence === 'sleep' || presence === 'driving') {
      const until = this.wakeAt(user.id);
      this.d.timers.schedule({
        planId: `p3dm:${user.id}`,
        kind: 'custom',
        id: `p3:dm:${key}`,
        fireAt: until,
        payload: { p3: 'dm', userId: user.id, text, key },
      });
      this.log.info({ userId: user.id, presence, until: new Date(until).toISOString() }, 'dm held');
      return;
    }
    await this.d.messaging.sendPrivateText({ userId: user.id, text, idempotencyKey: key });
  }

  private async deliverDeferred(p: Payload): Promise<void> {
    await this.d.messaging.sendPrivateText({
      userId: String(p['userId']),
      text: String(p['text']),
      idempotencyKey: String(p['key']),
    });
  }

  /** End of a sleep/driving command, else the next 07:00 New York. */
  private wakeAt(userId: string): number {
    const st = this.d.db.select().from(bubbleState).where(eq(bubbleState.userId, userId)).get();
    const nowMs = this.now().getTime();
    if (st?.presenceUntil && Date.parse(st.presenceUntil) > nowMs)
      return Date.parse(st.presenceUntil);
    const hour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        hourCycle: 'h23',
      }).format(this.now()),
    );
    const hoursTo7 = hour < 7 ? 7 - hour : 24 - hour + 7;
    const at = new Date(nowMs + hoursTo7 * 3_600_000);
    at.setUTCMinutes(0, 0, 0);
    return at.getTime();
  }

  /** Whether the Watcher could find this person right now (Find My or a recent pin). */
  private async locatable(userId: string): Promise<boolean> {
    try {
      return (await this.d.bubbles.readLocation(userId)).value !== null;
    } catch {
      return false;
    }
  }

  private async attending(s: BookingSummary): Promise<User[]> {
    // The database is the source of truth: someone who said no after the summary was built
    // must not get an invite or a bill. Order follows the summary (join order).
    const current = new Map(
      this.d.db
        .select({ userId: planMembers.userId, status: planMembers.status })
        .from(planMembers)
        .where(eq(planMembers.planId, s.planId))
        .all()
        .map((m) => [m.userId, m.status]),
    );
    const ordered = [...new Set([...s.members.map((m) => m.userId), ...current.keys()])];
    const out: User[] = [];
    for (const id of ordered) {
      const status = current.get(id);
      if (status !== 'in' && status !== 'represented') continue;
      const u = await this.d.crews.userById(id);
      if (u) out.push(u);
    }
    return out;
  }
}

export interface WatchReport {
  planId: string;
  at: string;
  members: Array<{
    userId: string;
    etaMin: number | null;
    minutesLate: number | null;
    here: boolean;
  }>;
}

/**
 * The one optional ask for a location, tied to what it gets them. A pin only lasts the
 * evening, which is a much smaller ask than sharing for good.
 */
export function lateNudge(venueName: string): string {
  return (
    `Running late? Send me a location pin before you head out and I'll ask ${venueName} to ` +
    'hold the table. Totally optional; your crew never sees where you are.'
  );
}

/** Walk under 1.5 km (80 m/min), otherwise drive (400 m/min) plus 5 minutes to park. */
export function etaMinutes(meters: number): number {
  if (meters <= 1500) return Math.max(1, Math.round(meters / 80));
  return Math.round(meters / 400) + 5;
}

const watchTimerId = (planId: string) => `p3:watch:${planId}`;

/** One hard limit in a few words, for the person's own summary: "no tree nut", "under $50". */
export function limitPhrase(f: { type: string; value: string }): string {
  const v = f.value.replace(/_/g, ' ');
  switch (f.type) {
    case 'allergy':
      return `no ${v}`;
    case 'budget_max':
      return `under $${f.value} a person`;
    case 'accessibility':
      return v === 'quiet' ? 'a quiet place' : `${v} access`;
    default:
      return v; // diet, religious_diet
  }
}

/** A Google Maps search link: by address when known, else by coordinates. */
export function mapsLink(venue: Pick<Venue, 'address' | 'location'>): string {
  const query = venue.address ?? `${venue.location.lat},${venue.location.lng}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  });
}
