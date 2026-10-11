/**
 * P3 doers: Inviter, Splitter, Watcher (the DoerPorts), plus absent representation summaries.
 * Owner: P3.
 *
 * - Inviter DMs each attending member a short .ics link (/ics/<signed>.ics).
 * - Splitter estimates per-person cost from the price level, picks the payer (attending member
 *   with a payment method and the fewest "paid" ledger rows in this crew), DMs everyone else
 *   the payer's methods (Venmo, Cash App, PayPal links with the amount; Zelle as text), and
 *   records the payer in the ledger. Fast-food venues (style fast_food or price level 1) get no
 *   split, and anyone who said they don't split is left off the bill.
 * - Watcher wakes 45 minutes before the booking and every 60 s after: reads Find My, estimates
 *   ETAs, updates the live card, and reports anyone 15+ minutes late (once per member).
 * - Representation: when a plan locks, each represented member gets a private summary with a
 *   veto option.
 *
 * Quiet hours: nobody asleep or driving is pinged. Their DMs wait in a durable timer until the
 * presence expires (sleep ends 07:00). Messages carry names, times, and amounts only; never
 * another member's facts.
 */
import { and, desc, eq, ne, sql } from 'drizzle-orm';
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
} from '@bubbleworks/shared';
import { payLine } from '../bubbles/payments.js';
import type { DbBubbleService } from '../bubbles/service.js';
import type { Db } from '../db/client.js';
import {
  audit,
  bookings,
  bubbleState,
  ledger,
  planMembers,
  plans,
  timers,
  venues,
} from '../db/schema.js';
import { silentLogger, type Logger } from '../events/bus.js';
import type { TimerService } from '../timers/service.js';
import { distanceM } from '../venues/geo.js';
import { buildIcs, signBookingToken, verifyBookingToken } from './ics.js';
import { LedgerWriter } from './ledger.js';

/** Per-person estimate by venue price level, USD (role prompt: 1 = 15, 2 = 30, 3 = 55). */
export const COST_BY_PRICE_LEVEL: Record<number, number> = { 1: 15, 2: 30, 3: 55, 4: 85 };
/** At or below this price level (OSM fast_food / cafe) the Splitter stays quiet. */
export const COUNTER_SERVICE_MAX_PRICE_LEVEL = 1;
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
    for (const u of people) {
      await this.dm(
        u,
        `${s.venue.name}, ${when}, table for ${people.length} under ${s.reservationName}. ` +
          `Add it to your calendar: ${url}`,
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

  private async split(s: BookingSummary & { idempotencyKey: string }): Promise<DoerResult> {
    // Counter service (fast food, cafes: style fast_food or price level 1 from OSM) means
    // everyone pays at the register, so there is nothing to split and nobody gets a message.
    if (s.venue.style === 'fast_food' || s.venue.priceLevel <= COUNTER_SERVICE_MAX_PRICE_LEVEL) {
      this.log.info({ planId: s.planId, venue: s.venue.name }, 'split skipped: counter service');
      return { ok: true, detail: 'Counter service, everyone pays for themselves' };
    }
    const each = COST_BY_PRICE_LEVEL[s.venue.priceLevel] ?? s.venue.typicalCostUsd;
    const groupId = this.groupIdOf(s.planId);
    const attending = await this.attending(s);
    // Anyone who said they don't split pays for themselves: off the bill, no messages.
    const people = attending.filter((u) => !this.d.bubbles.optedOutOfSplits(u.id));
    if (people.length < 2) {
      // A re-split that drops to one person on the bill: nobody is fronting anything now.
      this.d.db
        .delete(ledger)
        .where(eq(ledger.id, `ledger_paid_${s.bookingId}`))
        .run();
      this.log.info(
        { planId: s.planId, attending: attending.length, onBill: people.length },
        'split skipped: fewer than 2 on the bill',
      );
      return { ok: true, detail: 'No split, everyone pays for themselves' };
    }
    const handlesOf = new Map(people.map((u) => [u.id, this.d.bubbles.payHandles(u.id)]));
    const withHandle = people
      .map((u) => ({ u, handles: handlesOf.get(u.id)! }))
      .filter((x) => x.handles.length > 0);
    if (!withHandle.length) {
      return { ok: false, detail: 'Nobody has a payment method yet' };
    }

    // History only: this plan's own rows (a first split's paid row) must not count against anyone.
    const count = (userId: string, kind: 'paid' | 'compromised') =>
      Number(
        this.d.db
          .select({ n: sql<number>`count(*)` })
          .from(ledger)
          .where(
            and(
              eq(ledger.userId, userId),
              eq(ledger.kind, kind),
              eq(ledger.groupId, groupId),
              ne(ledger.planId, s.planId),
            ),
          )
          .get()?.n ?? 0,
      );
    // A re-split keeps the payer if they are still attending, so the bill never flips.
    // Otherwise: fewest times paid in this crew; ties go to whoever has compromised least (the
    // person who keeps bending is not also the one fronting the bill); then join order, then id.
    const prior = this.lastSplit(s.bookingId);
    const order = new Map(s.members.map((m, i) => [m.userId, i]));
    const payer =
      withHandle.find((x) => x.u.id === prior?.payerId) ??
      withHandle
        .map((x) => ({ ...x, paid: count(x.u.id, 'paid'), bent: count(x.u.id, 'compromised') }))
        .sort(
          (a, b) =>
            a.paid - b.paid ||
            a.bent - b.bent ||
            (order.get(a.u.id) ?? 99) - (order.get(b.u.id) ?? 99) ||
            a.u.id.localeCompare(b.u.id),
        )[0]!;

    // Count only who is attending now (in or represented), never s.partySize from the booking.
    const total = each * people.length;
    const note = `${s.venue.name} ${shortDay(s.startAt)}`;
    // Each person sees the payer's methods, the ones they use too first.
    const linesFor = (u: User) => {
      const theirs = new Set((handlesOf.get(u.id) ?? []).map((h) => h.method));
      return [...payer.handles]
        .sort((a, b) => Number(theirs.has(b.method)) - Number(theirs.has(a.method)))
        .map((h) => payLine(h, payer.u.displayName, each, note));
    };

    // A rerun after someone dropped (the engine re-splits on a table change): anyone on the
    // last split who is no longer attending is told they are off the bill.
    const nowIds = new Set(people.map((u) => u.id));
    const stillComing = new Set(attending.map((u) => u.id));
    for (const id of prior?.userIds ?? []) {
      // Someone still coming who opted out already got "ignore any link" from their bubble.
      if (nowIds.has(id) || stillComing.has(id)) continue;
      const gone = await this.d.crews.userById(id);
      if (!gone) continue;
      await this.dm(
        gone,
        `Plans changed and you're not on ${s.venue.name} anymore, so you're off the bill. ` +
          'Ignore the earlier payment link.',
        `${s.idempotencyKey}:offbill:${id}`,
      );
    }

    await this.dm(
      payer.u,
      `You're covering ${s.venue.name} this time, about $${total} for ${people.length} ($${each} each). ` +
        "I'll send everyone else a way to pay you back. It rotates, so next time is someone else.",
      `${s.idempotencyKey}:payer`,
    );
    let requests = 0;
    for (const u of people) {
      if (u.id === payer.u.id) continue;
      const lines = linesFor(u);
      await this.dm(
        u,
        `${payer.u.displayName} is covering ${s.venue.name}. Your share is about $${each}:` +
          (lines.length === 1
            ? ` ${lines[0]!.replace(/^(Venmo|Cash App|PayPal): /, '')}`
            : `\n${lines.join('\n')}`),
        `${s.idempotencyKey}:${u.id}`,
      );
      requests++;
    }

    // One paid row per booking; a re-split moves it to the current payer and total.
    const at = this.now().toISOString();
    this.d.db
      .insert(ledger)
      .values({
        id: `ledger_paid_${s.bookingId}`,
        groupId,
        planId: s.planId,
        userId: payer.u.id,
        kind: 'paid',
        amount: total,
        note: s.venue.name,
        at,
      })
      .onConflictDoUpdate({ target: ledger.id, set: { userId: payer.u.id, amount: total, at } })
      .run();
    this.d.db
      .insert(audit)
      .values({
        planId: s.planId,
        at,
        actor: 'p3_splitter',
        action: 'split_sent',
        detail: { bookingId: s.bookingId, payerId: payer.u.id, userIds: [...nowIds], each },
      })
      .run();
    // Keep the fairness ledger in step with who is actually attending.
    this.ledger.recordPlan(s.planId);
    this.log.info({ planId: s.planId, payer: payer.u.id, each, requests }, 'split sent');
    return { ok: true, detail: `${payer.u.displayName} covers, ${requests} payment requests sent` };
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

  private lastSplit(bookingId: string): { userIds: string[]; payerId: string } | null {
    const rows = this.d.db
      .select({ detail: audit.detail })
      .from(audit)
      .where(and(eq(audit.actor, 'p3_splitter'), eq(audit.action, 'split_sent')))
      .orderBy(desc(audit.id))
      .all();
    const hit = rows.find((r) => r.detail?.['bookingId'] === bookingId)?.detail;
    return hit
      ? { userIds: (hit['userIds'] as string[]) ?? [], payerId: String(hit['payerId']) }
      : null;
  }

  private groupIdOf(planId: string): string {
    return (
      this.d.db.select({ g: plans.groupId }).from(plans).where(eq(plans.id, planId)).get()?.g ?? ''
    );
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

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
  });
}
