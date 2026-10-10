/**
 * Candidate precompute. Per group: venues open at the plan's time, compatible with every
 * member's hard (non-budget) facts, inside the group's area. Cached in memory per
 * (group, date, start) and rebuilt on fact or member changes via invalidate().
 *
 * Exclusion details are server-internal. They name fact types so "why" can explain itself to
 * the operator; they never reach the page or the group.
 */
import {
  VENUE_RADIUS_M,
  type Fact,
  type Group,
  type IsoDate,
  type Venue,
} from '@bubbleworks/shared';
import { silentLogger, type Logger } from '../events/bus.js';
import { incompatibilities } from './compat.js';
import { distanceM } from './geo.js';
import { dayOfWeek, isOpenAt } from './hours.js';

export const DEFAULT_DINNER_MINUTES = 19 * 60;

export interface CandidateQuery {
  groupId: string;
  date: IsoDate;
  /** Local minutes since midnight. Defaults to 19:00. */
  startMinutes?: number | null;
  /** Only these members count (e.g. those marked in). Defaults to every group member. */
  memberIds?: string[];
}

export type ExclusionReason = 'closed' | 'too_far' | 'incompatible';

export interface Exclusion {
  venueId: string;
  name: string;
  reason: ExclusionReason;
  /** For incompatible: which members' fact types blocked it (ids only, never shown to users). */
  detail?: Array<{ userId: string; factTypes: string[] }>;
  distanceM?: number;
}

export interface CandidateSet {
  groupId: string;
  date: IsoDate;
  startMinutes: number;
  memberIds: string[];
  venues: Venue[];
  excluded: Exclusion[];
  builtAt: string;
  fromCache: boolean;
}

export interface CandidateIndexDeps {
  venues: () => Venue[];
  group: (groupId: string) => Group | null;
  memberIds: (groupId: string) => string[];
  hardFacts: (userId: string) => Promise<Fact[]>;
  radiusM?: number;
  log?: Logger;
  now?: () => Date;
}

export class CandidateIndex {
  private readonly cache = new Map<string, CandidateSet>();
  private readonly radiusM: number;
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(private readonly deps: CandidateIndexDeps) {
    this.radiusM = deps.radiusM ?? VENUE_RADIUS_M;
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? (() => new Date());
  }

  async forGroup(query: CandidateQuery): Promise<CandidateSet> {
    const startMinutes = query.startMinutes ?? DEFAULT_DINNER_MINUTES;
    const memberIds = [...(query.memberIds ?? this.deps.memberIds(query.groupId))].sort();
    const key = `${query.groupId}|${query.date}|${startMinutes}|${memberIds.join(',')}`;
    const cached = this.cache.get(key);
    if (cached) return { ...cached, fromCache: true };

    const t0 = performance.now();
    const group = this.deps.group(query.groupId);
    if (!group) throw new Error(`group ${query.groupId} not found`);
    const day = dayOfWeek(query.date);
    const factsByMember = new Map<string, Fact[]>();
    for (const userId of memberIds) {
      factsByMember.set(
        userId,
        (await this.deps.hardFacts(userId)).filter((f) => f.hard),
      );
    }

    const venues: Venue[] = [];
    const excluded: Exclusion[] = [];
    for (const venue of this.deps.venues()) {
      if (!isOpenAt(venue.hours, day, startMinutes)) {
        excluded.push({ venueId: venue.id, name: venue.name, reason: 'closed' });
        continue;
      }
      if (group.center) {
        const d = distanceM(group.center, venue.location);
        if (d > this.radiusM) {
          excluded.push({ venueId: venue.id, name: venue.name, reason: 'too_far', distanceM: d });
          continue;
        }
      }
      const blockers: Array<{ userId: string; factTypes: string[] }> = [];
      for (const [userId, facts] of factsByMember) {
        const bad = incompatibilities(venue, facts);
        if (bad.length)
          blockers.push({ userId, factTypes: [...new Set(bad.map((b) => b.factType))] });
      }
      if (blockers.length) {
        excluded.push({
          venueId: venue.id,
          name: venue.name,
          reason: 'incompatible',
          detail: blockers,
        });
        continue;
      }
      venues.push(venue);
    }

    const set: CandidateSet = {
      groupId: query.groupId,
      date: query.date,
      startMinutes,
      memberIds,
      venues,
      excluded,
      builtAt: this.now().toISOString(),
      fromCache: false,
    };
    this.cache.set(key, set);
    this.log.info(
      {
        groupId: query.groupId,
        candidates: venues.length,
        excluded: excluded.length,
        ms: Math.round(performance.now() - t0),
      },
      'candidates built',
    );
    return set;
  }

  /** Drop cached sets for one group (fact or member change) or for every group. */
  invalidate(groupId?: string): void {
    if (!groupId) {
      this.cache.clear();
      return;
    }
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${groupId}|`)) this.cache.delete(key);
    }
  }

  size(): number {
    return this.cache.size;
  }
}
