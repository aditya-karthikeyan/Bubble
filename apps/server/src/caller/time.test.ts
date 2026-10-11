import { describe, expect, it } from 'vitest';
import { addMinutes, formatLocalTime, parseLocalTime } from './time.js';

const TZ = 'America/New_York';
const SEVEN_PM_EDT = '2026-10-10T23:00:00.000Z';

describe('caller times', () => {
  it('formats venue-local times with a plain space', () => {
    expect(formatLocalTime(SEVEN_PM_EDT, TZ)).toBe('7:00 PM');
    expect(formatLocalTime(addMinutes(SEVEN_PM_EDT, -30), TZ)).toBe('6:30 PM');
  });

  it('reads the times a venue says back', () => {
    expect(parseLocalTime('7:15 PM', SEVEN_PM_EDT, TZ)).toBe('2026-10-10T23:15:00.000Z');
    expect(parseLocalTime('7:45pm', SEVEN_PM_EDT, TZ)).toBe('2026-10-10T23:45:00.000Z');
    expect(parseLocalTime('19:30', SEVEN_PM_EDT, TZ)).toBe('2026-10-10T23:30:00.000Z');
    expect(parseLocalTime('8', SEVEN_PM_EDT, TZ)).toBe('2026-10-11T00:00:00.000Z');
    expect(parseLocalTime('no idea', SEVEN_PM_EDT, TZ)).toBeNull();
  });

  it('keeps the venue-local day when UTC has already rolled over', () => {
    // 9:30 PM EDT on Oct 10 is Oct 11 in UTC.
    expect(parseLocalTime('9:45 PM', '2026-10-11T01:30:00.000Z', TZ)).toBe(
      '2026-10-11T01:45:00.000Z',
    );
  });

  it('uses standard time after the DST change', () => {
    // Nov 4 2026, 7 PM EST = midnight UTC.
    expect(parseLocalTime('7 PM', '2026-11-04T23:30:00.000Z', TZ)).toBe('2026-11-05T00:00:00.000Z');
  });
});
