import type { Fact, GeoPoint, MealKind, Venue, VenueStyle } from '@bubbleworks/shared';

/** Everything the solver knows about one participating bubble. Server-internal. */
export interface SolverMember {
  userId: string;
  displayName: string;
  hardFacts: Fact[];
  softFacts: Fact[];
  /** Cuisine keys this member chose in the poll, empty when they did not vote. */
  pollChoices: string[];
  location: GeoPoint | null;
  recentVenueIds: string[];
  recentCompromiseCount: number;
  represented: boolean;
  /** Accepted concessions from the deadlock breaker: how far this member agreed to stretch. */
  slack?: { budgetUsd?: number; travelMin?: number };
}

export interface SolverContext {
  /** 0 = Sunday. */
  day: number;
  startMinutes: number;
  groupCenter: GeoPoint | null;
  /** Meal being planned; coffee shops only count for coffee, and never for dinner. */
  meal?: MealKind;
  /** Decided style (style poll or intent words); venues of the other style are out. */
  style?: VenueStyle | null;
  /** Decided cuisine (poll winner or named in the message); other cuisines are out. */
  cuisine?: string | null;
  /** Walking minutes a member may be from a venue; defaults to SOLVER.travel_limit_min. */
  travelLimitMin?: number;
}

export type InfeasibleReason =
  'closed' | 'meal' | 'style' | 'cuisine' | 'diet' | 'budget' | 'distance';

export interface Infeasibility {
  venueId: string;
  userId: string | null;
  reason: InfeasibleReason;
  /** Server-internal detail, e.g. "budget 20 < 22" or "walk 27 min". Never page-visible. */
  detail: string;
}

export interface MemberScore {
  userId: string;
  venueId: string;
  /** Normalized 0..1 within this member's view of the current candidate set. */
  score: number;
  approves: boolean;
}

export type BubbleStatus = 'fits' | 'stretching' | 'holding_firm' | 'represented';

export interface Round {
  round: number;
  candidates: Venue[];
  scores: MemberScore[];
  /** Weighted total support per venue, for the elimination order. */
  support: Record<string, number>;
  leaderVenueId: string | null;
  bubbles: Array<{ userId: string; displayName: string; status: BubbleStatus }>;
  eliminated: { venueId: string; reason: 'least_support' } | null;
}

export interface SolverResult {
  feasible: Venue[];
  infeasible: Infeasibility[];
  rounds: Round[];
  winner: Venue | null;
  backup: Venue | null;
  /** Members whose top choice survived until the lock. */
  unanimous: boolean;
}
