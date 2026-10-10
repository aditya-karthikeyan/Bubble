/**
 * Elimination rounds. Each round scores the remaining candidates per bubble, sums fairness-
 * weighted support per venue, and checks whether the leader holds every bubble's approval. If
 * not, the candidate with the least support leaves and the next round re-scores. Ties break on
 * venue id so a rerun gives the same answer. The runner-up at lock time is the backup.
 */
import type { Venue } from '@bubbleworks/shared';
import { filterCandidates } from './filter.js';
import { fairnessWeight, scoreAll } from './score.js';
import type {
  BubbleStatus,
  MemberScore,
  Round,
  SolverContext,
  SolverMember,
  SolverResult,
} from './types.js';

export interface SolveInput {
  venues: Venue[];
  members: SolverMember[];
  ctx: SolverContext;
  /** Venues a member vetoed; removed before round one. */
  vetoedVenueIds?: string[];
  /** Maximum rounds, a safety net; the loop ends when one candidate remains anyway. */
  maxRounds?: number;
}

function topVenueFor(userId: string, scores: MemberScore[]): string | null {
  const mine = scores
    .filter((s) => s.userId === userId)
    .sort((a, b) => b.score - a.score || a.venueId.localeCompare(b.venueId));
  return mine[0]?.venueId ?? null;
}

function bubbleStatus(
  m: SolverMember,
  scores: MemberScore[],
  leader: string | null,
  originalTop: string | null,
  remaining: Set<string>,
): BubbleStatus {
  if (m.represented) return 'represented';
  if (originalTop && remaining.has(originalTop)) return 'fits';
  const approvesLeader = leader
    ? scores.some((s) => s.userId === m.userId && s.venueId === leader && s.approves)
    : false;
  return approvesLeader ? 'stretching' : 'holding_firm';
}

export function solve(input: SolveInput): SolverResult {
  const vetoed = new Set(input.vetoedVenueIds ?? []);
  const { feasible, infeasible } = filterCandidates(
    input.venues.filter((v) => !vetoed.has(v.id)),
    input.members,
    input.ctx,
  );
  const rounds: Round[] = [];
  if (feasible.length === 0 || input.members.length === 0) {
    return { feasible, infeasible, rounds, winner: null, backup: null, unanimous: false };
  }

  let candidates = [...feasible];
  const weights = new Map(input.members.map((m) => [m.userId, fairnessWeight(m)]));
  const firstScores = scoreAll(candidates, input.members, input.ctx);
  const originalTop = new Map(
    input.members.map((m) => [m.userId, topVenueFor(m.userId, firstScores)]),
  );
  let lastEliminated: Venue | null = null;
  const maxRounds = input.maxRounds ?? candidates.length + 1;

  for (let round = 1; round <= maxRounds; round += 1) {
    const scores = round === 1 ? firstScores : scoreAll(candidates, input.members, input.ctx);
    const support: Record<string, number> = {};
    for (const v of candidates) support[v.id] = 0;
    for (const s of scores)
      support[s.venueId] = (support[s.venueId] ?? 0) + s.score * (weights.get(s.userId) ?? 1);
    const ordered = [...candidates].sort(
      (a, b) => (support[b.id] ?? 0) - (support[a.id] ?? 0) || a.id.localeCompare(b.id),
    );
    const leader = ordered[0] ?? null;
    const remaining = new Set(candidates.map((v) => v.id));
    const bubbles = input.members.map((m) => ({
      userId: m.userId,
      displayName: m.displayName,
      status: bubbleStatus(
        m,
        scores,
        leader?.id ?? null,
        originalTop.get(m.userId) ?? null,
        remaining,
      ),
    }));
    const everyoneApproves =
      leader !== null &&
      input.members.every((m) =>
        scores.some((s) => s.userId === m.userId && s.venueId === leader.id && s.approves),
      );

    if (leader && (everyoneApproves || candidates.length === 1)) {
      rounds.push({
        round,
        candidates: [...candidates],
        scores,
        support,
        leaderVenueId: leader.id,
        bubbles,
        eliminated: null,
      });
      const backup = ordered[1] ?? lastEliminated;
      const unanimous = input.members.every((m) => originalTop.get(m.userId) === leader.id);
      return { feasible, infeasible, rounds, winner: leader, backup: backup ?? null, unanimous };
    }

    const loser = ordered.at(-1)!;
    rounds.push({
      round,
      candidates: [...candidates],
      scores,
      support,
      leaderVenueId: leader?.id ?? null,
      bubbles,
      eliminated: { venueId: loser.id, reason: 'least_support' },
    });
    lastEliminated = loser;
    candidates = candidates.filter((v) => v.id !== loser.id);
  }

  const last = rounds.at(-1);
  const winner = last?.leaderVenueId
    ? (candidates.find((v) => v.id === last.leaderVenueId) ?? null)
    : null;
  return { feasible, infeasible, rounds, winner, backup: lastEliminated, unanimous: false };
}
