/**
 * FakeBubbles: serves the five seeded personas from memory. Presence, location, and free/busy
 * are settable per user so simulations can stage absent members and quiet hours.
 */
import type { BubbleProfile, BubbleService, InboundPrivateMessage } from '../ports.js';
import type {
  BusyInterval,
  Fact,
  GeoPoint,
  IsoDateTime,
  NewFact,
  Presence,
  User,
} from '../types.js';
import { DEMO_GROUP, PERSONAS, PERSONA_FACTS } from './personas.js';

export class FakeBubbles implements BubbleService {
  private readonly users = new Map<string, User>();
  private readonly facts = new Map<string, Fact[]>();
  private readonly presence = new Map<string, Presence>();
  private readonly location = new Map<string, GeoPoint | null>();
  private readonly busy = new Map<string, BusyInterval[]>();
  private readonly recentVenues = new Map<string, string[]>();
  private readonly compromises = new Map<string, number>();
  readonly onboarded: string[] = [];
  readonly privateMessages: InboundPrivateMessage[] = [];
  private counter = 0;

  constructor(users: User[] = PERSONAS, facts: Fact[] = PERSONA_FACTS) {
    for (const u of users) {
      this.users.set(u.id, u);
      this.facts.set(u.id, []);
      this.presence.set(u.id, 'available');
      this.location.set(u.id, DEMO_GROUP.center);
      this.busy.set(u.id, []);
    }
    for (const f of facts) this.facts.get(f.userId)?.push({ ...f });
  }

  async getProfile(userId: string): Promise<BubbleProfile> {
    const user = this.users.get(userId);
    if (!user) throw new Error(`FakeBubbles: unknown user ${userId}`);
    return {
      user,
      facts: [...(this.facts.get(userId) ?? [])],
      recentVenueIds: [...(this.recentVenues.get(userId) ?? [])],
      recentCompromiseCount: this.compromises.get(userId) ?? 0,
    };
  }

  async getHardLimits(userId: string): Promise<Fact[]> {
    return (this.facts.get(userId) ?? []).filter((f) => f.hard);
  }

  async getSoftPrefs(userId: string): Promise<Fact[]> {
    return (this.facts.get(userId) ?? []).filter((f) => !f.hard);
  }

  async getPresence(userId: string): Promise<Presence> {
    return this.presence.get(userId) ?? 'unknown';
  }

  async getLocation(userId: string): Promise<GeoPoint | null> {
    return this.location.get(userId) ?? null;
  }

  async getFreeBusy(
    userId: string,
    range: { start: IsoDateTime; end: IsoDateTime },
  ): Promise<BusyInterval[]> {
    const start = Date.parse(range.start);
    const end = Date.parse(range.end);
    return (this.busy.get(userId) ?? []).filter(
      (b) => Date.parse(b.end) > start && Date.parse(b.start) < end,
    );
  }

  async recordFact(input: NewFact): Promise<Fact> {
    this.counter += 1;
    const fact: Fact = {
      ...input,
      id: `fact_fake_${this.counter}`,
      createdAt: new Date().toISOString(),
    };
    const list = this.facts.get(input.userId);
    if (!list) throw new Error(`FakeBubbles: unknown user ${input.userId}`);
    list.push(fact);
    return fact;
  }

  async onNewMember(input: { groupId: string; chatId: string; userId: string }): Promise<void> {
    this.onboarded.push(input.userId);
    if (!this.users.has(input.userId)) {
      this.users.set(input.userId, {
        id: input.userId,
        displayName: input.userId,
        handle: input.userId,
        timezone: 'America/New_York',
        createdAt: new Date().toISOString(),
      });
      this.facts.set(input.userId, []);
      this.presence.set(input.userId, 'unknown');
      this.location.set(input.userId, null);
      this.busy.set(input.userId, []);
    }
  }

  async onPrivateMessage(message: InboundPrivateMessage): Promise<{ handled: boolean }> {
    this.privateMessages.push(message);
    return { handled: false };
  }

  // -- staging helpers for simulations ----------------------------------------

  setPresence(userId: string, presence: Presence): void {
    this.presence.set(userId, presence);
  }

  setLocation(userId: string, location: GeoPoint | null): void {
    this.location.set(userId, location);
  }

  setBusy(userId: string, intervals: BusyInterval[]): void {
    this.busy.set(userId, intervals);
  }

  setRecentVenues(userId: string, venueIds: string[]): void {
    this.recentVenues.set(userId, venueIds);
  }

  setCompromiseCount(userId: string, count: number): void {
    this.compromises.set(userId, count);
  }

  userIds(): string[] {
    return [...this.users.keys()];
  }
}
