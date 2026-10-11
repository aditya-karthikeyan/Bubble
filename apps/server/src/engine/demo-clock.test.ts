import { describe, expect, it } from 'vitest';
import { demoPlanningClock } from './demo-clock.js';
import { decideStartTime } from './question-policy.js';

const TZ = 'America/New_York';

describe('demoPlanningClock', () => {
  it('pins planning to the given local time on the real date', () => {
    const lateNight = new Date('2026-10-11T03:00:00.000Z'); // 11:00 PM Oct 10 in New York
    const clock = demoPlanningClock('18:00', TZ, () => lateNight);
    expect(clock().toISOString()).toBe('2026-10-10T22:00:00.000Z'); // 6:00 PM EDT
  });

  it('turns an 11 PM "dinner tonight" into an evening start instead of nothing', () => {
    const lateNight = new Date('2026-10-11T03:00:00.000Z');
    const real = decideStartTime(null, {}, '2026-10-10', TZ, lateNight);
    const demo = decideStartTime(
      null,
      {},
      '2026-10-10',
      TZ,
      demoPlanningClock('18:00', TZ, () => lateNight)(),
    );
    expect(real.startMinutes).toBeGreaterThanOrEqual(23 * 60 + 30);
    expect(demo.startMinutes).toBeLessThanOrEqual(19 * 60 + 30);
    expect(demo.startMinutes).toBeGreaterThanOrEqual(18 * 60 + 30);
  });
});
