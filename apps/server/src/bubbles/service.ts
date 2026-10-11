/**
 * DbBubbleService: the BubbleService port over SQLite. Owner: P3.
 *
 * Inbound non-plan DMs arrive at onPrivateMessage. In order, a bubble handles:
 *   1. "forget me" / "forget that"
 *   2. the one pending yes/no question (allergy check, crew invite, forget-me confirm)
 *   3. onboarding, five short questions, for anyone who has not finished it
 *   4. crew declarations ("my crew is Ava, Ben, +19195551234")
 * Anything else returns handled = false so the engine can treat it as a command.
 *
 * Privacy: a bubble only ever DMs its own person about their own facts. Crew invites and
 * crew updates carry names only. Logs carry ids and kinds, never message text or fact values.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  idempotencyKey,
  type BubbleProfile,
  type BubbleService,
  type BusyInterval,
  type CrewDirectory,
  type Fact,
  type GeoPoint,
  type Group,
  type InboundPrivateMessage,
  type IsoDateTime,
  type MessagingPort,
  type NewFact,
  type Presence,
  type User,
} from '@bubbleworks/shared';
import type { Db } from '../db/client.js';
import {
  asks,
  groupMembers,
  bubbleInbox,
  bubbleState,
  crewInvites,
  ledger,
  planMembers,
  users,
  venues,
  plans,
  timers,
  votes,
  type BubblePending,
} from '../db/schema.js';
import { silentLogger, type Logger } from '../events/bus.js';
import {
  HARD_FACT_TYPES,
  isSkip,
  resolveUntil,
  splitList,
  type ExtractedFact,
  type ExtractHint,
  type FactExtractor,
} from './extract.js';
import { describeFact, FactStore } from './facts.js';
import { PassiveLearner, type LearnInput } from './learner.js';
import { mightBeReaction, type ReactionClassifier } from './reactions.js';
import {
  inQuietHours,
  parsePresenceCommand,
  presenceUntil,
  SignalCache,
  type CachedRead,
  type FreeBusySource,
  type LocationFix,
  type LocationSource,
} from './signals.js';

export const ONBOARDING_STEPS = [
  'diet_allergy',
  'budget',
  'neighborhood',
  'favorites',
  'venmo',
] as const satisfies readonly ExtractHint[];
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

const QUESTIONS: Record<OnboardingStep, string> = {
  diet_allergy: "1/5 Anything you don't eat? Diet, allergies, halal, kosher, or just say none.",
  budget: '2/5 Usual budget per person for dinner? Like $20 or $30.',
  neighborhood: '3/5 What area are you usually in? Like Franklin St or Southpoint.',
  favorites: '4/5 Two favorite spots around here?',
  venmo: '5/5 Venmo handle, for splitting the bill? Or say skip.',
};

const FORGET_ME_WINDOW_MS = 5 * 60_000;

export interface BubbleServiceDeps {
  db: Db;
  crews: CrewDirectory;
  messaging: Pick<MessagingPort, 'sendPrivateText'>;
  extractor: FactExtractor;
  /** Short calendar connect link for a user, or null when Google is not configured. */
  calendarLink?: (userId: string) => string | null;
  /** Signup page for people who are not registered yet (WEB_PUBLIC_URL landing page). */
  signupUrl?: string | null;
  /** The engine's "crew changed, rerun" hook (PlanEngine.handleMemberChange). */
  onCrewChanged?: (input: {
    chatId: string;
    userId: string;
    change: 'joined' | 'left';
  }) => Promise<void>;
  /** Find My. Absent: getLocation falls back to the onboarding neighborhood. */
  locations?: LocationSource | null;
  /** Google free/busy. Absent: no calendar signal. */
  freeBusy?: FreeBusySource | null;
  /** Per-signal read budget; 300 ms in production. */
  signalBudgetMs?: number;
  /** Post-dinner verdicts ("that place was mid"). Absent: reactions are ignored. */
  reactions?: ReactionClassifier | null;
  now?: () => Date;
  log?: Logger;
}

type Reply = (text: string) => Promise<void>;

const LOCATION_TTL_MS = 5 * 60_000;
const FREEBUSY_TTL_MS = 5 * 60_000;

export class DbBubbleService implements BubbleService {
  readonly facts: FactStore;
  readonly learner: PassiveLearner;
  readonly locationCache: SignalCache<LocationFix>;
  readonly busyCache: SignalCache<BusyInterval[]>;
  private readonly db: Db;
  private readonly crews: CrewDirectory;
  private readonly now: () => Date;
  private readonly log: Logger;

  constructor(private readonly deps: BubbleServiceDeps) {
    this.db = deps.db;
    this.crews = deps.crews;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? silentLogger;
    this.facts = new FactStore(this.db, this.now);
    this.learner = new PassiveLearner({
      extractor: deps.extractor,
      apply: (input, found) => this.applyLearned(input, found),
      log: this.log,
    });
    const cacheOpts = {
      budgetMs: deps.signalBudgetMs ?? 300,
      now: () => this.now().getTime(),
      log: this.log,
    };
    this.locationCache = new SignalCache('location', LOCATION_TTL_MS, cacheOpts);
    this.busyCache = new SignalCache('freebusy', FREEBUSY_TTL_MS, cacheOpts);
  }

  // -- BubbleService reads ---------------------------------------------------

  async getProfile(userId: string): Promise<BubbleProfile> {
    const user = await this.crews.userById(userId);
    if (!user) throw new Error(`user ${userId} not found`);
    const since = new Date(this.now().getTime() - 30 * 86_400_000).toISOString();
    const compromised = this.db
      .select({ n: sql<number>`count(*)` })
      .from(ledger)
      .where(
        and(
          eq(ledger.userId, userId),
          eq(ledger.kind, 'compromised'),
          sql`${ledger.at} >= ${since}`,
        ),
      )
      .get();
    return {
      user,
      facts: this.facts.active(userId),
      recentVenueIds: [],
      recentCompromiseCount: Number(compromised?.n ?? 0),
    };
  }

  async getHardLimits(userId: string): Promise<Fact[]> {
    return this.facts.active(userId).filter((f) => f.hard);
  }

  async getSoftPrefs(userId: string): Promise<Fact[]> {
    return this.facts.active(userId).filter((f) => !f.hard);
  }

  /**
   * Presence, in order: a command the person sent ("busy", "sleeping", "driving") until it
   * expires; a calendar busy block covering now (focus); quiet hours 23:00 to 07:00 (sleep);
   * otherwise available. Focus is not readable on Photon Pro (docs/spikes/context.md).
   */
  async getPresence(userId: string): Promise<Presence> {
    const nowMs = this.now().getTime();
    const state = this.state(userId);
    if (state.presence && state.presenceUntil && Date.parse(state.presenceUntil) > nowMs) {
      return state.presence;
    }
    const day = this.localDayRange(this.now());
    const busy = await this.readBusy(userId, day);
    if (busy.value?.some((b) => Date.parse(b.start) <= nowMs && Date.parse(b.end) > nowMs)) {
      return 'focus';
    }
    if (inQuietHours(this.now())) return 'sleep';
    return 'available';
  }

  /**
   * Find My fix (cached up to 5 minutes), else the center of seeded venues matching the
   * person's onboarding neighborhood, else null.
   */
  async getLocation(userId: string): Promise<GeoPoint | null> {
    const read = await this.readLocation(userId);
    if (read.value) return { lat: read.value.lat, lng: read.value.lng };
    return this.neighborhoodCenter(userId);
  }

  async getFreeBusy(
    userId: string,
    range: { start: IsoDateTime; end: IsoDateTime },
  ): Promise<BusyInterval[]> {
    const read = await this.readBusy(userId, range);
    const start = Date.parse(range.start);
    const end = Date.parse(range.end);
    return (read.value ?? []).filter((b) => Date.parse(b.end) > start && Date.parse(b.start) < end);
  }

  /** Warm every member's signals when a plan starts, so the first reads hit the cache. */
  prefetchSignals(userIds: string[]): void {
    const day = this.localDayRange(this.now());
    for (const id of userIds) {
      void this.readLocation(id);
      void this.readBusy(id, day);
    }
  }

  async readLocation(userId: string): Promise<CachedRead<LocationFix>> {
    const source = this.deps.locations;
    if (!source) return { value: null, from: 'none', ageMs: null, ms: 0 };
    const user = await this.crews.userById(userId);
    if (!user) return { value: null, from: 'none', ageMs: null, ms: 0 };
    return this.locationCache.read(userId, () => source.get(user.handle));
  }

  async readBusy(
    userId: string,
    range: { start: string; end: string },
  ): Promise<CachedRead<BusyInterval[]>> {
    const source = this.deps.freeBusy;
    if (!source) return { value: null, from: 'none', ageMs: null, ms: 0 };
    return this.busyCache.read(`${userId}|${range.start}|${range.end}`, () =>
      source.busy(userId, range),
    );
  }

  private localDayRange(d: Date): { start: string; end: string } {
    const ymd = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const start = new Date(`${ymd}T00:00:00Z`);
    // Offset of New York from UTC at this moment, in ms.
    const offset =
      new Date(d.toLocaleString('en-US', { timeZone: 'UTC' })).getTime() -
      new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' })).getTime();
    const s = new Date(start.getTime() + offset);
    return { start: s.toISOString(), end: new Date(s.getTime() + 86_400_000).toISOString() };
  }

  private neighborhoodCenter(userId: string): GeoPoint | null {
    const hood = this.facts.current(userId, 'neighborhood')?.value;
    if (!hood) return null;
    const words = streetKey(hood)
      .split(' ')
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
    if (!words.length) return null;
    const rows = this.db
      .select({
        lat: venues.lat,
        lng: venues.lng,
        address: venues.address,
        hood: venues.neighborhood,
      })
      .from(venues)
      .all()
      .filter((v) => {
        const hay = streetKey(`${v.address ?? ''} ${v.hood ?? ''}`);
        return words.every((w) => hay.includes(w));
      });
    if (!rows.length) return null;
    return {
      lat: rows.reduce((a, v) => a + v.lat, 0) / rows.length,
      lng: rows.reduce((a, v) => a + v.lng, 0) / rows.length,
    };
  }

  async recordFact(fact: NewFact): Promise<Fact> {
    return this.facts.record(fact);
  }

  /** A member was added to a crew from outside the DM flow: start onboarding if needed. */
  async onNewMember(input: { groupId: string; chatId: string; userId: string }): Promise<void> {
    const state = this.state(input.userId);
    if (state.onboardingCompletedAt || state.onboardingStep) return;
    await this.startOnboarding(input.userId, this.replier(input.userId, `member:${input.groupId}`));
  }

  isOnboarded(userId: string): boolean {
    return this.state(userId).onboardingCompletedAt !== null;
  }

  // -- inbound DMs -----------------------------------------------------------

  async onPrivateMessage(message: InboundPrivateMessage): Promise<{ handled: boolean }> {
    // Claim the message id first so a concurrent redelivery cannot double-answer.
    const claimed = this.db
      .insert(bubbleInbox)
      .values({
        messageId: message.messageId,
        userId: message.userId,
        handled: true,
        at: this.now().toISOString(),
      })
      .onConflictDoNothing()
      .run();
    if (claimed.changes === 0) {
      const prior = this.db
        .select()
        .from(bubbleInbox)
        .where(eq(bubbleInbox.messageId, message.messageId))
        .get();
      return { handled: prior?.handled ?? true };
    }

    const t0 = performance.now();
    let handled: boolean;
    try {
      handled = await this.route(message);
    } catch (err) {
      this.log.error(
        { userId: message.userId, messageId: message.messageId, err: (err as Error).message },
        'bubble failed to handle a DM',
      );
      handled = false;
    }
    this.db
      .update(bubbleInbox)
      .set({ handled })
      .where(eq(bubbleInbox.messageId, message.messageId))
      .run();
    this.log.info(
      { userId: message.userId, handled, ms: Math.round(performance.now() - t0) },
      'bubble dm',
    );
    return { handled };
  }

  private async route(m: InboundPrivateMessage): Promise<boolean> {
    const user = await this.crews.userById(m.userId);
    if (!user) return false;
    const text = m.text.trim();
    const reply = this.replier(user.id, m.messageId);

    if (/^forget me\b/i.test(text)) {
      this.setPending(user.id, {
        kind: 'forget_me_confirm',
        expiresAt: new Date(this.now().getTime() + FORGET_ME_WINDOW_MS).toISOString(),
      });
      await reply(
        'This deletes everything I know about you and takes you out of your crews. ' +
          'Reply yes to confirm.',
      );
      return true;
    }
    if (/^forget (that|it|the last thing)\b/i.test(text)) {
      const gone = this.facts.deleteLatest(user.id);
      await reply(
        gone ? `Done, I forgot that ${this.describe(gone)}.` : "There's nothing to forget yet.",
      );
      return true;
    }

    const state = this.state(user.id);
    if (state.pending && (await this.answerPending(user, state.pending, text, reply))) {
      return true;
    }

    const presence = parsePresenceCommand(text);
    if (presence) {
      await this.setPresence(user.id, presence, reply);
      return true;
    }

    if (!state.onboardingCompletedAt) {
      if (!state.onboardingStep) await this.startOnboarding(user.id, reply);
      else if (isDone(state.onboardingStep)) await this.finishOnboarding(user, reply);
      else await this.answerOnboarding(user, state.onboardingStep, text, reply);
      return true;
    }

    const crewNames = parseCrewDeclaration(text);
    if (crewNames) {
      await this.declareCrew(user, crewNames, reply);
      return true;
    }
    // Not for the bubble: the engine gets it, and the learner reads it in the background.
    this.learn({ messageId: m.messageId, userId: user.id, text, at: m.at });
    return false;
  }

  /** Feed any message the person wrote (DM or crew plan thread) to the background learner. */
  learn(input: LearnInput): void {
    this.learner.enqueue(input);
    if (this.deps.reactions && mightBeReaction(input.text)) {
      void this.reactTo(input).catch((err: unknown) =>
        this.log.warn({ userId: input.userId, err: (err as Error).message }, 'reaction failed'),
      );
    }
  }

  /**
   * A verdict on the last place they ate at, within 18 hours after the booking. Negative lowers
   * that cuisine (a like loses 0.3 confidence and flips to avoid below 0.35) and drops the venue
   * from favorites; positive saves the venue as a favorite and the cuisine as a like.
   * Returns what changed, for tests and the demo.
   */
  async reactTo(input: LearnInput): Promise<string | null> {
    const classifier = this.deps.reactions;
    if (!classifier || !this.isOnboarded(input.userId)) return null;
    const nowMs = this.now().getTime();
    const recent = this.db
      .select({ planId: plans.id, venueId: plans.chosenVenueId, startAt: plans.startAt })
      .from(plans)
      .innerJoin(planMembers, eq(planMembers.planId, plans.id))
      .where(
        and(
          eq(planMembers.userId, input.userId),
          inArray(planMembers.status, ['in', 'represented']),
          inArray(plans.state, ['BOOKED', 'DAY_OF', 'CLOSED']),
        ),
      )
      .orderBy(desc(plans.startAt))
      .all()
      .find((p) => {
        const start = p.startAt ? Date.parse(p.startAt) : NaN;
        return p.venueId && nowMs > start && nowMs - start < 18 * 3_600_000;
      });
    if (!recent?.venueId) return null;
    const venue = this.db.select().from(venues).where(eq(venues.id, recent.venueId)).get();
    if (!venue) return null;

    const verdict = await classifier.classify(input.text, venue.name);
    if (!verdict.about_place || verdict.sentiment === 'neutral') return null;
    const base = {
      userId: input.userId,
      hard: false,
      source: 'reaction' as const,
      confirmed: false,
      expiresAt: null,
    };

    if (verdict.sentiment === 'negative') {
      const fav = this.facts
        .active(input.userId)
        .find((f) => f.type === 'favorite_venue' && f.value === venue.id);
      if (fav) this.facts.delete([fav.id]);
      const like = this.facts
        .active(input.userId)
        .find((f) => f.type === 'cuisine_like' && f.value === venue.cuisine);
      if (like && like.confidence - 0.3 >= 0.35) {
        this.facts.setConfidence(like.id, like.confidence - 0.3);
      } else {
        this.facts.record({
          ...base,
          type: 'cuisine_avoid',
          value: venue.cuisine,
          confidence: 0.4,
        });
      }
      this.facts.record({
        ...base,
        type: 'other',
        value: `avoid_venue:${venue.id}`,
        confidence: 0.6,
      });
      this.log.info(
        { userId: input.userId, venueId: venue.id },
        'reaction: lowered venue and cuisine',
      );
      return `lowered ${venue.name} and ${venue.cuisine}`;
    }
    this.facts.record({ ...base, type: 'favorite_venue', value: venue.id, confidence: 0.6 });
    const avoid = this.facts
      .active(input.userId)
      .find((f) => f.type === 'other' && f.value === `avoid_venue:${venue.id}`);
    if (avoid) this.facts.delete([avoid.id]);
    if (
      !this.facts
        .active(input.userId)
        .some((f) => f.type === 'cuisine_avoid' && f.value === venue.cuisine)
    ) {
      this.facts.record({ ...base, type: 'cuisine_like', value: venue.cuisine, confidence: 0.5 });
    }
    this.log.info({ userId: input.userId, venueId: venue.id }, 'reaction: raised venue');
    return `raised ${venue.name}`;
  }

  /** Late joiner wrap-up: short, then straight into the crew and the live plan. */
  private async finishFast(user: User, reply: Reply): Promise<void> {
    const known = this.summarize(user.id);
    await reply(
      `You're in ✨ ${known.length ? `I'll plan around this: ${known.join('; ')}. ` : ''}` +
        "I'll ask about favorite spots and Venmo after tonight.",
    );
    this.log.info({ userId: user.id }, 'late joiner onboarded');
    // Already a confirmed member: join the live plan now. Otherwise the crew invite comes next.
    const active = this.activePlanFor(user.id);
    if (active) {
      const crew = await this.crews.crewByChatId(active.chatId);
      const member = crew
        ? this.db
            .select({ c: groupMembers.confirmedAt })
            .from(groupMembers)
            .where(and(eq(groupMembers.groupId, crew.id), eq(groupMembers.userId, user.id)))
            .get()
        : undefined;
      if (member?.c) {
        await this.deps.onCrewChanged?.({
          chatId: active.chatId,
          userId: user.id,
          change: 'joined',
        });
      }
    }
    await this.deliverNextInvite(user.id);
  }

  private async setPresence(
    userId: string,
    command: ReturnType<typeof parsePresenceCommand> & string,
    reply: Reply,
  ): Promise<void> {
    if (command === 'available') {
      this.upsertState(userId, { presence: null, presenceUntil: null });
      await reply("Welcome back. I'll include you in plans again.");
      return;
    }
    const until = presenceUntil(command, this.now());
    this.upsertState(userId, { presence: command, presenceUntil: until });
    const when = new Date(until).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
    });
    const what = { focus: 'busy', sleep: 'asleep', driving: 'driving' }[command];
    await reply(
      `Got it, you're ${what} until ${when}. No pings till then; your bubble can still plan for ` +
        "you within your hard limits. Say 'back' anytime.",
    );
    this.log.info({ userId, presence: command, until }, 'presence set');
  }

  /**
   * Saves facts the learner found. Soft facts save directly. Hard facts save unconfirmed (they
   * still filter, so a learned allergy is never ignored) and get one private yes/no.
   */
  private async applyLearned(input: LearnInput, found: ExtractedFact[]): Promise<void> {
    const state = this.state(input.userId);
    if (!state.onboardingCompletedAt) return; // onboarding answers are handled in the DM flow
    const saved = await this.saveExtracted(input.userId, found, 'chat', input.text);
    const ask = saved.filter((f) => f.hard && !f.confirmed);
    this.log.info(
      { userId: input.userId, messageId: input.messageId, saved: saved.length, ask: ask.length },
      'facts learned from chat',
    );
    if (!ask.length || this.state(input.userId).pending) return;
    this.setPending(input.userId, { kind: 'fact_confirm', factIds: ask.map((f) => f.id) });
    const list = ask
      .map((f) => this.describe(f) + (f.expiresAt ? ` until ${shortDate(f.expiresAt)}` : ''))
      .join(' and ');
    await this.replier(
      input.userId,
      `learned:${input.messageId}`,
    )(`Noticed ${list}. Should I treat that as a hard rule for plans? (yes/no)`);
  }

  // -- pending yes/no --------------------------------------------------------

  /** Returns false when the text is not an answer, so routing continues with it. */
  private async answerPending(
    user: User,
    pending: BubblePending,
    text: string,
    reply: Reply,
  ): Promise<boolean> {
    const yes = isYes(text);
    const no = isNo(text);

    switch (pending.kind) {
      case 'forget_me_confirm': {
        this.setPending(user.id, null);
        if (yes && Date.parse(pending.expiresAt) > this.now().getTime()) {
          await reply('Done. Everything I knew about you is gone. Text me anytime to start over.');
          await this.forgetUser(user.id);
          return true;
        }
        if (no) {
          await reply('Okay, keeping everything.');
          return true;
        }
        return false;
      }

      case 'allergy_confirm': {
        if (!yes && !no) {
          await reply('Just yes or no: is that allergy right?');
          return true;
        }
        this.setPending(user.id, null);
        if (yes) this.facts.confirm(pending.factIds);
        else this.facts.delete(pending.factIds);
        await reply(yes ? "Got it, that's a hard rule for every plan." : "Okay, I won't save it.");
        await this.continueOnboarding(user, reply);
        return true;
      }

      case 'fact_confirm': {
        this.setPending(user.id, null);
        if (!yes && !no) return false; // moved on; the facts stay unconfirmed but still filter
        if (yes) this.facts.confirm(pending.factIds);
        else this.facts.delete(pending.factIds);
        await reply(yes ? 'Locked in.' : "Okay, I'll forget it.");
        await this.deliverNextInvite(user.id);
        return true;
      }

      case 'crew_confirm': {
        if (!yes && !no) {
          await reply('Want in on the crew? Just yes or no.');
          return true;
        }
        this.setPending(user.id, null);
        await this.answerInvite(user, pending.groupId, yes, reply);
        await this.deliverNextInvite(user.id);
        return true;
      }
    }
  }

  // -- onboarding ------------------------------------------------------------

  private async startOnboarding(userId: string, reply: Reply): Promise<void> {
    const user = await this.crews.userById(userId);
    const nowIso = this.now().toISOString();
    // Late joiner: a crew they belong to (or are invited to) is planning right now, so ask
    // only what changes tonight's decision and let them join the live plan.
    const fast = this.activePlanFor(userId) !== null;
    const first: OnboardingStep = 'diet_allergy'; // first in both flows
    this.upsertState(userId, {
      onboardingStep: encodeStep(first, fast),
      onboardingStartedAt: nowIso,
    });
    // First message to a new person: no links, no media (Apple deliverability rule).
    const intro = fast
      ? `Hey ${user?.displayName ?? 'there'}, I'm your bubble 🫧 Your crew is planning food ` +
        "right now, so three quick questions and you're in."
      : `Hey ${user?.displayName ?? 'there'}, I'm your bubble 🫧 I plan food with your crew ` +
        "so the group chat doesn't have to. Five quick questions, about a minute.";
    await reply(`${intro}\n\n${question(first, fast)}`);
    this.log.info({ userId, fast }, 'onboarding started');
  }

  /** The crew plan in flight (not yet locked) for any crew this person is in or invited to. */
  activePlanFor(userId: string): { planId: string; chatId: string } | null {
    const groupIds = this.db
      .select({ g: groupMembers.groupId })
      .from(groupMembers)
      .where(eq(groupMembers.userId, userId))
      .all()
      .map((r) => r.g);
    if (!groupIds.length) return null;
    const row = this.db
      .select({ planId: plans.id, chatId: plans.chatId })
      .from(plans)
      .where(and(inArray(plans.groupId, groupIds), inArray(plans.state, [...JOINABLE_STATES])))
      .orderBy(desc(plans.createdAt))
      .get();
    return row ?? null;
  }

  private async answerOnboarding(
    user: User,
    raw: string,
    text: string,
    reply: Reply,
  ): Promise<void> {
    const { step, fast } = decodeStep(raw);
    const steps: readonly OnboardingStep[] = fast ? FAST_STEPS : ONBOARDING_STEPS;
    const extracted = isSkip(text) ? [] : await this.deps.extractor.extract(text, step);
    const saved = await this.saveExtracted(user.id, extracted, step, text);

    if (step === 'budget' && !isSkip(text) && !saved.some((f) => f.type === 'budget_max')) {
      await reply('Just a number works, like 25. Or say skip.');
      return;
    }

    const allergies = saved.filter((f) => f.type === 'allergy' && !f.confirmed);
    const next = steps[steps.indexOf(step) + 1] ?? null;
    this.upsertState(user.id, {
      onboardingStep: next ? encodeStep(next, fast) : fast ? 'fast:done' : 'done',
    });

    if (allergies.length) {
      this.setPending(user.id, { kind: 'allergy_confirm', factIds: allergies.map((f) => f.id) });
      const list = joinNames(allergies.map((f) => f.value.replace(/_/g, ' ')));
      await reply(
        `Quick check, since this one is never bent for anyone: you're allergic to ${list}? (yes/no)`,
      );
      return;
    }
    await this.continueOnboarding(user, reply);
  }

  /** Asks the next question, or wraps up when every question is answered. */
  private async continueOnboarding(user: User, reply: Reply): Promise<void> {
    const state = this.state(user.id);
    if (state.onboardingCompletedAt) return;
    const raw = state.onboardingStep;
    if (raw && !isDone(raw)) {
      const { step, fast } = decodeStep(raw);
      await reply(question(step, fast));
      return;
    }
    await this.finishOnboarding(user, reply);
  }

  private async finishOnboarding(user: User, reply: Reply): Promise<void> {
    const st = this.state(user.id);
    const started = st.onboardingStartedAt;
    const fast = st.onboardingStep?.startsWith('fast:') ?? false;
    this.upsertState(user.id, {
      onboardingStep: null,
      onboardingCompletedAt: this.now().toISOString(),
    });
    if (fast) {
      await this.finishFast(user, reply);
      return;
    }
    const known = this.summarize(user.id);
    const summary = known.length ? `Here's what I know: ${known.join('; ')}.` : '';
    const extras: string[] = [];
    const cal = this.deps.calendarLink?.(user.id) ?? null;
    if (cal) extras.push(`Calendar (I only see busy or free, never what): ${cal}`);
    extras.push(
      user.bubbleNumber
        ? `Find My: People, then +, Share My Location, send to ${user.bubbleNumber}, Share Indefinitely.`
        : 'Find My: share your location with this number from the Find My app.',
    );
    await reply(
      [
        `All set ✨ ${summary}`.trim(),
        "Say 'forget that' anytime to drop the last thing.",
        '',
        'Two optional extras so plans fit your real day:',
        ...extras.map((e) => `• ${e}`),
        '',
        "Next, tell me your crew: 'my crew is' plus names or numbers.",
      ].join('\n'),
    );
    const seconds = started
      ? Math.round((this.now().getTime() - Date.parse(started)) / 1000)
      : null;
    this.log.info({ userId: user.id, seconds, facts: known.length }, 'onboarding complete');
    await this.deliverNextInvite(user.id);
  }

  private async saveExtracted(
    userId: string,
    extracted: ExtractedFact[],
    step: ExtractHint,
    rawText: string,
  ): Promise<Fact[]> {
    const out: Fact[] = [];
    const source = step === 'chat' ? 'chat' : 'onboarding';
    for (const e of extracted) {
      let { type, value } = e;
      if (type === 'favorite_venue') {
        const venueId = this.matchVenue(value);
        if (venueId) value = venueId;
        else {
          type = 'other';
          value = `favorite spot: ${e.value}`;
        }
      }
      const hard = HARD_FACT_TYPES.has(type);
      out.push(
        this.facts.record({
          userId,
          type,
          value,
          hard,
          confidence: e.confidence,
          source,
          // Allergies wait for an explicit yes. Other onboarding answers are the person's own words.
          confirmed: type === 'allergy' ? false : source === 'onboarding',
          expiresAt: e.until_phrase ? resolveUntil(e.until_phrase, this.now()) : null,
        }),
      );
    }
    // A neighborhood answer the extractor could not read is still the person's own words.
    if (step === 'neighborhood' && !out.length && !isSkip(rawText) && rawText.trim()) {
      out.push(
        this.facts.record({
          userId,
          type: 'neighborhood',
          value: rawText.trim().slice(0, 80),
          hard: false,
          confidence: 0.6,
          source,
          confirmed: true,
          expiresAt: null,
        }),
      );
    }
    return out;
  }

  private matchVenue(name: string): string | null {
    const key = normalizeName(name);
    if (!key) return null;
    const rows = this.db.select({ id: venues.id, name: venues.name }).from(venues).all();
    const exact = rows.find((v) => normalizeName(v.name) === key);
    if (exact) return exact.id;
    const partial = rows.filter((v) => {
      const n = normalizeName(v.name);
      return key.length >= 4 && (n.includes(key) || key.includes(n));
    });
    return partial.length === 1 ? partial[0]!.id : null;
  }

  /**
   * The person's own facts, oldest first. A temporary value shows its end date and the value it
   * falls back to: "your budget is up to $15 a person until Fri Oct 16, then $30".
   */
  private summarize(userId: string): string[] {
    const all = this.facts.active(userId).slice().reverse();
    const out: string[] = [];
    for (const f of all) {
      const temp = all.find((o) => o.type === f.type && o.expiresAt !== null);
      if (f.expiresAt === null && temp && temp !== f) continue; // folded into the temporary one
      if (f.expiresAt !== null) {
        const usual = all.find((o) => o.type === f.type && o.expiresAt === null);
        const then = usual
          ? `, then ${usual.type === 'budget_max' ? `$${usual.value}` : usual.value}`
          : '';
        out.push(`${this.describe(f)} until ${shortDate(f.expiresAt)}${then}`);
      } else out.push(this.describe(f));
    }
    return out;
  }

  private describe(f: Fact): string {
    if (f.type === 'favorite_venue') {
      const v = this.db
        .select({ name: venues.name })
        .from(venues)
        .where(eq(venues.id, f.value))
        .get();
      return describeFact({ type: f.type, value: v?.name ?? 'a place you like' });
    }
    return describeFact(f);
  }

  // -- crews -----------------------------------------------------------------

  private async declareCrew(creator: User, names: CrewDeclaration, reply: Reply): Promise<void> {
    const found: User[] = [];
    const missing: string[] = [];
    const ambiguous: string[] = [];
    for (const token of names.members) {
      const r = await this.resolveMember(token, creator.id);
      if (r.kind === 'found') {
        if (!found.some((u) => u.id === r.user.id)) found.push(r.user);
      } else if (r.kind === 'ambiguous') ambiguous.push(token);
      else if (r.kind === 'missing') missing.push(token);
    }

    const notes: string[] = [];
    if (missing.length) {
      notes.push(
        `I couldn't find ${joinNames(missing)}. They need a bubble first` +
          (this.deps.signupUrl ? ` (${this.deps.signupUrl})` : '') +
          ', then tell me again.',
      );
    }
    if (ambiguous.length) {
      notes.push(
        `More than one person matches ${joinNames(ambiguous)}. Send their number instead.`,
      );
    }
    if (!found.length) {
      await reply(notes.join(' ') || "Who's in it? Like: my crew is Ava, Ben, +19195551234");
      return;
    }

    const crew = await this.crews.createCrew({
      name: names.name ?? `${creator.displayName}'s crew`,
      createdByUserId: creator.id,
      memberIds: found.map((u) => u.id),
    });
    const nowIso = this.now().toISOString();
    for (const u of found) {
      this.db
        .insert(crewInvites)
        .values({
          groupId: crew.id,
          userId: u.id,
          invitedByUserId: creator.id,
          status: 'waiting',
          sentAt: null,
          createdAt: nowIso,
        })
        .onConflictDoNothing()
        .run();
    }
    this.log.info({ userId: creator.id, groupId: crew.id, invited: found.length }, 'crew declared');

    await reply(
      [
        `Made ${crew.name}. I asked ${joinNames(found.map((u) => u.displayName))} to confirm, ` +
          "and I'll tell you when everyone's in.",
        ...notes,
      ].join(' '),
    );
    for (const u of found) await this.deliverNextInvite(u.id);
  }

  private async resolveMember(
    token: string,
    selfId: string,
  ): Promise<{ kind: 'found'; user: User } | { kind: 'missing' | 'ambiguous' | 'self' }> {
    const phone = toE164(token);
    if (phone) {
      const user = await this.crews.userByHandle(phone);
      if (!user) return { kind: 'missing' };
      return user.id === selfId ? { kind: 'self' } : { kind: 'found', user };
    }
    const name = token.trim().toLowerCase();
    if (/^(me|myself|i)$/.test(name)) return { kind: 'self' };
    const rows = this.db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .all()
      .filter((u) => u.id !== selfId);
    const exact = rows.filter((u) => u.displayName.toLowerCase() === name);
    const byFirst = rows.filter((u) => u.displayName.toLowerCase().split(/\s+/)[0] === name);
    const matches = exact.length ? exact : byFirst;
    if (matches.length > 1) return { kind: 'ambiguous' };
    const id = matches[0]?.id;
    const user = id ? await this.crews.userById(id) : null;
    return user ? { kind: 'found', user } : { kind: 'missing' };
  }

  /** Sends the oldest waiting invite once the person is onboarded and has no open question. */
  private async deliverNextInvite(userId: string): Promise<void> {
    const state = this.state(userId);
    if (!state.onboardingCompletedAt || state.pending) return;
    const invite = this.db
      .select()
      .from(crewInvites)
      .where(and(eq(crewInvites.userId, userId), eq(crewInvites.status, 'waiting')))
      .orderBy(crewInvites.createdAt)
      .limit(1)
      .get();
    if (!invite) return;
    const crew = await this.crews.crewById(invite.groupId);
    if (!crew) return;
    const inviter = await this.crews.userById(invite.invitedByUserId);
    const others = (await this.crews.membersOf(crew.id))
      .filter((u) => u.id !== userId && u.id !== invite.invitedByUserId)
      .map((u) => u.displayName);
    const withWhom = others.length ? ` with ${joinNames(others)}` : '';
    this.setPending(userId, { kind: 'crew_confirm', groupId: crew.id });
    this.db
      .update(crewInvites)
      .set({ status: 'sent', sentAt: this.now().toISOString() })
      .where(and(eq(crewInvites.groupId, crew.id), eq(crewInvites.userId, userId)))
      .run();
    await this.replier(
      userId,
      `invite:${crew.id}`,
    )(
      `${inviter?.displayName ?? 'Someone'} added you to ${crew.name}${withWhom}. ` +
        'Your bubble plans with theirs and never shares your details. Want in? (yes/no)',
    );
  }

  private async answerInvite(
    user: User,
    groupId: string,
    accepted: boolean,
    reply: Reply,
  ): Promise<void> {
    const crew = await this.crews.crewById(groupId);
    if (!crew) {
      await reply('That crew is gone now.');
      return;
    }
    this.db
      .update(crewInvites)
      .set({ status: accepted ? 'accepted' : 'declined' })
      .where(and(eq(crewInvites.groupId, groupId), eq(crewInvites.userId, user.id)))
      .run();

    if (!accepted) {
      const after = await this.crews.removeMember(groupId, user.id);
      await reply("No worries, you're not in it.");
      if (after.createdByUserId) {
        await this.replier(
          after.createdByUserId,
          `declined:${groupId}:${user.id}`,
        )(`${user.displayName} passed on ${after.name}.`);
      }
      await this.announceIfActive(after, crew.status);
      await this.deps.onCrewChanged?.({ chatId: crew.chatId, userId: user.id, change: 'left' });
      return;
    }

    const after = await this.crews.confirmMember(groupId, user.id);
    await reply(`You're in ${after.name}.`);
    await this.announceIfActive(after, crew.status);
    await this.deps.onCrewChanged?.({ chatId: crew.chatId, userId: user.id, change: 'joined' });
  }

  private async announceIfActive(crew: Group, before: Group['status']): Promise<void> {
    if (crew.status !== 'active' || before === 'active') return;
    const members = await this.crews.membersOf(crew.id);
    if (members.length < 2) return;
    const names = joinNames(members.map((u) => u.displayName));
    for (const u of members) {
      await this.replier(
        u.id,
        `active:${crew.id}`,
      )(`${crew.name} is set: ${names}. Anyone can text "dinner tonight?" to start a plan.`);
    }
    this.log.info({ groupId: crew.id, members: members.length }, 'crew active');
  }

  // -- forget me -------------------------------------------------------------

  /** Deletes the person and every row about them. Group rows they created stay. */
  async forgetUser(userId: string): Promise<void> {
    const crews = await this.crews.crewsOf(userId);
    this.db.transaction((tx) => {
      tx.delete(ledger).where(eq(ledger.userId, userId)).run();
      tx.delete(votes).where(eq(votes.userId, userId)).run();
      tx.delete(asks).where(eq(asks.userId, userId)).run();
      tx.delete(planMembers).where(eq(planMembers.userId, userId)).run();
      tx.delete(bubbleInbox).where(eq(bubbleInbox.userId, userId)).run();
      tx.delete(crewInvites).where(eq(crewInvites.invitedByUserId, userId)).run();
      // Cascades: facts, group_members, bubble_state, crew_invites (as invitee), google_tokens.
      // DMs held for quiet hours carry text for this person.
      tx.delete(timers)
        .where(eq(timers.planId, `p3dm:${userId}`))
        .run();
      tx.delete(users).where(eq(users.id, userId)).run();
    });
    this.facts.evict(userId);
    this.learner.forget(userId);
    this.locationCache.delete(userId);
    this.log.info({ userId, crews: crews.length }, 'forget me: user deleted');
    for (const c of crews) {
      await this.deps.onCrewChanged?.({ chatId: c.chatId, userId, change: 'left' });
    }
  }

  // -- state helpers ---------------------------------------------------------

  private state(userId: string): typeof bubbleState.$inferSelect {
    return (
      this.db.select().from(bubbleState).where(eq(bubbleState.userId, userId)).get() ?? {
        userId,
        onboardingStep: null,
        onboardingStartedAt: null,
        onboardingCompletedAt: null,
        pending: null,
        presence: null,
        presenceUntil: null,
        updatedAt: this.now().toISOString(),
      }
    );
  }

  private upsertState(
    userId: string,
    patch: Partial<Omit<typeof bubbleState.$inferInsert, 'userId'>>,
  ): void {
    const row = { ...this.state(userId), ...patch, updatedAt: this.now().toISOString() };
    this.db
      .insert(bubbleState)
      .values(row)
      .onConflictDoUpdate({ target: bubbleState.userId, set: row })
      .run();
  }

  private setPending(userId: string, pending: BubblePending | null): void {
    this.upsertState(userId, { pending });
  }

  /** Outbound DM with a deterministic idempotency key per inbound message and reply index. */
  private replier(userId: string, cause: string): Reply {
    let n = 0;
    return async (text: string) => {
      await this.deps.messaging.sendPrivateText({
        userId,
        text,
        idempotencyKey: idempotencyKey(`bubble:${userId}`, 'dm', cause, n++),
      });
    };
  }

  /** Users with onboarding finished, for the demo and tests. */
  onboardedUserIds(): string[] {
    return this.db
      .select({ userId: bubbleState.userId })
      .from(bubbleState)
      .where(sql`${bubbleState.onboardingCompletedAt} is not null`)
      .all()
      .map((r) => r.userId);
  }

  /** Pending crew invites for a set of crews, for the demo. */
  invitesFor(groupIds: string[]): Array<typeof crewInvites.$inferSelect> {
    if (!groupIds.length) return [];
    return this.db.select().from(crewInvites).where(inArray(crewInvites.groupId, groupIds)).all();
  }
}

// -- parsing helpers ---------------------------------------------------------

export interface CrewDeclaration {
  members: string[];
  name: string | null;
}

/** "my crew is Ava, Ben and +19195551234 called Thursday Eats" -> names + optional crew name. */
export function parseCrewDeclaration(text: string): CrewDeclaration | null {
  const m =
    /^(?:my |our |the )?crew\s*(?:is|=|:|-|with)\s+(.+)$/i.exec(text.trim()) ??
    /^(?:make|start|create|new)\s+(?:a\s+)?crew\s+(?:with|of|:)?\s*(.+)$/i.exec(text.trim());
  if (!m?.[1]) return null;
  let body = m[1];
  let name: string | null = null;
  const named = /\s+(?:called|named)\s+(.+)$/i.exec(body);
  if (named?.[1]) {
    name = named[1].trim().replace(/[.!]+$/, '');
    body = body.slice(0, named.index);
  }
  const members = splitList(body.replace(/[.!]+$/, ''));
  return members.length ? { members, name } : null;
}

export function toE164(token: string): string | null {
  const digits = token.replace(/[^\d+]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
  const bare = digits.replace(/\+/g, '');
  if (/^\d{10}$/.test(bare)) return `+1${bare}`;
  if (/^1\d{10}$/.test(bare)) return `+${bare}`;
  return null;
}

export function isYes(text: string): boolean {
  return (
    /^\s*(y|yes|yeah|yea|yep|yup|ya|sure|correct|right|ok|okay|confirm|in|i'?m in|👍)\b[\s!.]*$/i.test(
      text,
    ) || /^\s*👍/.test(text)
  );
}

export function isNo(text: string): boolean {
  return (
    /^\s*(n|no|nope|nah|wrong|not really|pass|i'?m out|out)\b[\s!.]*$/i.test(text) ||
    /^\s*👎/.test(text)
  );
}

/** Late joiners answer only what changes tonight's decision. */
const FAST_STEPS = [
  'diet_allergy',
  'budget',
  'neighborhood',
] as const satisfies readonly OnboardingStep[];
/** Plans a late joiner can still join (not yet locked). */
const JOINABLE_STATES = ['DETECTED', 'GATHERING', 'DELIBERATING', 'DEADLOCK'] as const;

function encodeStep(step: OnboardingStep, fast: boolean): string {
  return fast ? `fast:${step}` : step;
}

function decodeStep(raw: string): { step: OnboardingStep; fast: boolean } {
  const fast = raw.startsWith('fast:');
  return { step: (fast ? raw.slice(5) : raw) as OnboardingStep, fast };
}

function isDone(raw: string): boolean {
  return raw === 'done' || raw === 'fast:done';
}

/** The question for a step, numbered within its flow ("2/3" for late joiners). */
function question(step: OnboardingStep, fast: boolean): string {
  const steps: readonly OnboardingStep[] = fast ? FAST_STEPS : ONBOARDING_STEPS;
  return `${steps.indexOf(step) + 1}/${steps.length} ${QUESTIONS[step].replace(/^\d\/\d /, '')}`;
}

const STOP_WORDS = new Set([
  'near',
  'around',
  'mostly',
  'usually',
  'area',
  'downtown',
  'chapel',
  'hill',
]);

/** Lowercase words with street suffixes spelled out, so "Franklin St" matches "Franklin Street". */
function streetKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\bst\b/g, 'street')
    .replace(/\bave?\b/g, 'avenue')
    .replace(/\brd\b/g, 'road')
    .replace(/\bblvd\b/g, 'boulevard')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Fri Oct 16" in New York time. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|restaurant|cafe|bar|grill|kitchen)\b/g, '')
    .trim();
}
