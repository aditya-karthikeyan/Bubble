import { describe, expect, it } from 'vitest';
import { dayOfWeek, isOpenAt, localTime, parseOpeningHours } from './hours.js';

const h = (m: number) => m;

describe('parseOpeningHours', () => {
  it('handles 24/7', () => {
    const w = parseOpeningHours('24/7')!;
    expect(w[0]).toEqual([{ open: 0, close: 1440 }]);
    expect(w[6]).toEqual([{ open: 0, close: 1440 }]);
  });

  it('handles day ranges and semicolons without spaces', () => {
    const w = parseOpeningHours('Mo-Sa 06:00-23:00;Su 06:30-21:00')!;
    expect(w[1]).toEqual([{ open: 360, close: 1380 }]);
    expect(w[0]).toEqual([{ open: 390, close: 1260 }]);
  });

  it('handles comma-separated rules with comma day lists', () => {
    const w = parseOpeningHours('Tu-Th 11:30-21:30, Fr,Sa 11:30-22:30, Su 17:00-21:00')!;
    expect(w[2]).toEqual([{ open: 690, close: 1290 }]);
    expect(w[5]).toEqual([{ open: 690, close: 1350 }]);
    expect(w[6]).toEqual([{ open: 690, close: 1350 }]);
    expect(w[0]).toEqual([{ open: 1020, close: 1260 }]);
    expect(w[1]).toEqual([]);
  });

  it('handles split shifts and wrap-around day ranges', () => {
    const w = parseOpeningHours('Su-Th 11:00-21:00; Fr-Sa 11:00-22:00')!;
    expect(w[0]![0]!.close).toBe(1260);
    expect(w[4]![0]!.close).toBe(1260);
    expect(w[5]![0]!.close).toBe(1320);
    const split = parseOpeningHours('Th 11:30-14:30,17:00-21:30')!;
    expect(split[4]).toEqual([
      { open: 690, close: 870 },
      { open: 1020, close: 1290 },
    ]);
  });

  it('handles no-day rules, past-midnight closes, open-ended, and off', () => {
    expect(parseOpeningHours('11:15-21:00')![3]).toEqual([{ open: 675, close: 1260 }]);
    expect(parseOpeningHours('Fr-Sa 11:00-00:30')![5]).toEqual([{ open: 660, close: 1470 }]);
    expect(parseOpeningHours('Mo-Su 11:00-04:00')![1]).toEqual([{ open: 660, close: 1680 }]);
    expect(parseOpeningHours('Tu-Su 12:00+')![2]).toEqual([{ open: 720, close: 1440 }]);
    const off = parseOpeningHours('Mo-Fr 09:00-17:00; Sa,Su off')!;
    expect(off[6]).toEqual([]);
    expect(off[1]).toEqual([{ open: 540, close: 1020 }]);
  });

  it('rejects what it cannot read', () => {
    expect(parseOpeningHours('')).toBeNull();
    expect(parseOpeningHours('sunrise-sunset')).toBeNull();
    expect(parseOpeningHours('Mo-Fr 9am-5pm')).toBeNull();
  });
});

describe('isOpenAt', () => {
  const w = parseOpeningHours('Mo-Th 11:00-22:00; Fr-Sa 11:00-02:00; Su off')!;
  it('respects the minimum stay', () => {
    expect(isOpenAt(w, 1, h(19 * 60))).toBe(true);
    expect(isOpenAt(w, 1, h(21 * 60 + 30))).toBe(false);
    expect(isOpenAt(w, 1, h(21 * 60 + 30), 15)).toBe(true);
    expect(isOpenAt(w, 1, h(10 * 60))).toBe(false);
  });
  it('counts the previous day running past midnight', () => {
    expect(isOpenAt(w, 6, h(0 * 60 + 30))).toBe(true); // Saturday 00:30 via Friday
    expect(isOpenAt(w, 0, h(0 * 60 + 30))).toBe(true); // Sunday 00:30 via Saturday
    expect(isOpenAt(w, 0, h(19 * 60))).toBe(false); // Sunday evening: off
    expect(isOpenAt(w, 2, h(0 * 60 + 30))).toBe(false); // Tuesday 00:30: Monday closed at 22
  });
});

describe('local time helpers', () => {
  it('maps instants to local day and minutes', () => {
    // 2026-10-10 is a Saturday. 23:30Z is 19:30 in New York (EDT).
    expect(localTime(new Date('2026-10-10T23:30:00Z'), 'America/New_York')).toEqual({
      day: 6,
      minutes: 1170,
    });
    expect(dayOfWeek('2026-10-10')).toBe(6);
    expect(dayOfWeek('2026-10-11')).toBe(0);
  });
});
