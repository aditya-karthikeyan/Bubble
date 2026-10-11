/**
 * Deadlock breaker, part one: analysis. When no venue fits every bubble, find the smallest
 * concession per member and per relaxable limit that would make at least one venue feasible,
 * cost each by size times (1 + the member's recent compromise count), and find a time shift
 * that would work with no concession at all. Pure and deterministic.
 *
 * Never relaxed: allergy, religious_diet, accessibility (NEVER_RELAX_FACT_TYPES). Diet is not
 * relaxed either; only budget and distance are negotiable, time is a group-level fallback.
 */
import { CONCESSION_STEPS, type Venue } from '@bubbleworks/shared';
import { budgetOf, filterCandidates } from '../solver/filter.js';
import type { SolverContext, SolverMember } from '../solver/types.js';

export type ConcessionKind = 'budget' | 'distance';

export interface Concession {
  userId: string;
  kind: ConcessionKind;
  factType: 'budget_max' | 'distance';
  /** Current limit, as the ask will phrase it: dollars for budget, walking minutes for distance. */
  from: number;
  to: number;
  /** 1..3 steps of the configured size. */
  steps: number;
  /** steps * (1 + recentCompromiseCount). Lower is cheaper to ask. */
  cost: number;
  /** Venues this concession alone would make feasible for the whole table. */
  enablesVenueIds: string[];
}

export interface TimeShift {
  startMinutes: number;
  deltaMinutes: number;
  enablesVenueIds: string[];
}

export interface DeadlockAnalysis {
  /** Cheapest first; ties broken by user id then kind. */
  concessions: Concession[];
  /** A different start where everyone fits without any concession, when one exists. */
  timeShift: TimeShift | null;
}

const BUDGET_STEPS = [1, 2, 3]
  .map((n) => n * CONCESSION_STEPS.budget_step_usd)
  .filter((v) => v <= CONCESSION_STEPS.budget_max_usd);
const DISTANCE_STEPS = [1, 2]
  .map((n) => n * CONCESSION_STEPS.distance_step_min)
  .filter((v) => v <= CONCESSION_STEPS.distance_max_min);
const TIME_DELTAS = [
  CONCESSION_STEPS.time_step_min,
  -CONCESSION_STEPS.time_step_min,
  CONCESSION_STEPS.time_max_min,
  -CONCESSION_STEPS.time_max_min,
];

function withSlack(
  members: SolverMember[],
  userId: string,
  slack: SolverMember['slack'],
): SolverMember[] {
  return members.map((m) => (m.userId === userId ? { ...m, slack: { ...m.slack, ...slack } } : m));
}

export function analyzeDeadlock(
  venues: Venue[],
  members: SolverMember[],
  ctx: SolverContext,
  options: { minStartMinutes?: number } = {},
): DeadlockAnalysis {
  const concessions: Concession[] = [];
  for (const m of members) {
    const weight = 1 + m.recentCompromiseCount;
    const budget = budgetOf(m);
    if (budget !== null) {
      for (const [i, step] of BUDGET_STEPS.entries()) {
        const { feasible } = filterCandidates(
          venues,
          withSlack(members, m.userId, { budgetUsd: step }),
          ctx,
        );
        if (feasible.length) {
          concessions.push({
            userId: m.userId,
            kind: 'budget',
            factType: 'budget_max',
            from: budget,
            to: budget + step,
            steps: i + 1,
            cost: (i + 1) * weight,
            enablesVenueIds: feasible.map((v) => v.id),
          });
          break;
        }
      }
    }
    // Distance is only negotiable when we know where the person actually is; a group-center
    // guess must never produce a "would you walk further?" ask.
    if (m.location) {
      for (const [i, step] of DISTANCE_STEPS.entries()) {
        const { feasible } = filterCandidates(
          venues,
          withSlack(members, m.userId, { travelMin: step }),
          ctx,
        );
        if (feasible.length) {
          concessions.push({
            userId: m.userId,
            kind: 'distance',
            factType: 'distance',
            from: 20,
            to: 20 + step,
            steps: i + 1,
            cost: (i + 1) * weight,
            enablesVenueIds: feasible.map((v) => v.id),
          });
          break;
        }
      }
    }
  }
  concessions.sort(
    (a, b) => a.cost - b.cost || a.userId.localeCompare(b.userId) || a.kind.localeCompare(b.kind),
  );

  let timeShift: TimeShift | null = null;
  for (const delta of TIME_DELTAS) {
    const start = ctx.startMinutes + delta;
    if (start < 11 * 60 || start > 22 * 60) continue;
    if (start < (options.minStartMinutes ?? 0)) continue;
    const { feasible } = filterCandidates(venues, members, { ...ctx, startMinutes: start });
    if (feasible.length) {
      timeShift = {
        startMinutes: start,
        deltaMinutes: delta,
        enablesVenueIds: feasible.map((v) => v.id),
      };
      break;
    }
  }
  return { concessions, timeShift };
}

/** The two cheapest concessions that go to two different people. */
export function pickAsks(analysis: DeadlockAnalysis): Concession[] {
  const out: Concession[] = [];
  for (const c of analysis.concessions) {
    if (out.some((o) => o.userId === c.userId)) continue;
    out.push(c);
    if (out.length === 2) break;
  }
  return out;
}
