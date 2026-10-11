/**
 * DEMO_PLAN_CLOCK: decide start times as if it were a fixed local time today, so a rehearsal at
 * 11 PM (or 2 AM) still plans dinner for the early evening against real venue hours instead of
 * dead-ending in takeout. Only start-time decisions use it; deadlines and timers stay real.
 */
import { zonedInstant } from './question-policy.js';

export function demoPlanningClock(
  hhmm: string,
  timezone = 'America/New_York',
  now: () => Date = () => new Date(),
): () => Date {
  const [h, m] = hhmm.split(':').map(Number);
  const minutes = (h ?? 18) * 60 + (m ?? 0);
  return () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now());
    return new Date(zonedInstant(today, minutes, timezone));
  };
}
