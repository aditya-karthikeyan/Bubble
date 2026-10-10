/**
 * Poll arithmetic shared by the engine (P1) and the messaging adapter's early close (P2).
 */

export interface PollDecision {
  /** True when no remaining voter could change the leader. */
  decided: boolean;
  /** Option key in the lead, or null when nothing has a vote yet or the top is tied. */
  leader: string | null;
  /** Lead over the runner-up, in votes. */
  margin: number;
}

/**
 * counts: option key -> votes so far. remainingVoters: people who have not voted yet.
 * The poll is decided when the leader's margin over the runner-up exceeds the votes still out,
 * or when nobody is left to vote and the top is not tied. Single-select semantics: each
 * remaining voter can add at most one vote to the runner-up.
 */
export function isPollDecided(
  counts: Record<string, number>,
  remainingVoters: number,
): PollDecision {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = entries[0];
  if (!top || top[1] === 0) return { decided: remainingVoters <= 0, leader: null, margin: 0 };
  const second = entries[1]?.[1] ?? 0;
  const margin = top[1] - second;
  if (margin === 0) return { decided: false, leader: null, margin: 0 };
  return { decided: margin > Math.max(0, remainingVoters), leader: top[0], margin };
}

/** Tally per-voter choices into counts. A voter with several choices counts once per option. */
export function tallyChoices(
  choicesByVoter: Record<string, string[]>,
  optionKeys: string[],
): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(optionKeys.map((k) => [k, 0]));
  for (const choices of Object.values(choicesByVoter)) {
    for (const c of new Set(choices)) if (c in counts) counts[c] = (counts[c] ?? 0) + 1;
  }
  return counts;
}
