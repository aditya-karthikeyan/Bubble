/**
 * Opening hours: a tolerant parser for the common OSM opening_hours shapes, plus helpers to
 * ask whether a venue is open at a local time. WeeklyHours index 0 is Sunday.
 *
 * Supported: "24/7", "Mo-Fr 11:00-22:00", "Mo-Sa 06:00-23:00;Su 06:30-21:00",
 * "Tu-Th 11:30-21:30, Fr,Sa 11:30-22:30, Su 17:00-21:00", "Th 11:30-14:30,17:00-21:30",
 * "11:15-21:00" (every day), "Fr-Sa 11:00-00:30" (closes after midnight), "Su off", "12:00+".
 * Anything else returns null and the venue is skipped at import.
 */
import type { OpenInterval, WeeklyHours } from '@bubbleworks/shared';

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;
const DAY_INDEX = new Map<string, number>(DAYS.map((d, i) => [d, i]));
const TIME_RANGE = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;
const OPEN_ENDED = /^(\d{1,2}):(\d{2})\+$/;
const DAY_SPEC = /^(Mo|Tu|We|Th|Fr|Sa|Su|PH)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/;

export function emptyWeek(): WeeklyHours {
  return [[], [], [], [], [], [], []];
}

export function allWeek(interval: OpenInterval): WeeklyHours {
  return DAYS.map(() => [{ ...interval }]);
}

function expandDays(spec: string): number[] | null {
  const m = DAY_SPEC.exec(spec);
  if (!m) return null;
  if (m[1] === 'PH') return [];
  const start = DAY_INDEX.get(m[1]!)!;
  if (!m[2]) return [start];
  const end = DAY_INDEX.get(m[2])!;
  const days: number[] = [];
  for (let d = start; ; d = (d + 1) % 7) {
    days.push(d);
    if (d === end) break;
  }
  return days;
}

function parseRange(token: string): OpenInterval | null {
  const r = TIME_RANGE.exec(token);
  if (r) {
    const open = Number(r[1]) * 60 + Number(r[2]);
    let close = Number(r[3]) * 60 + Number(r[4]);
    if (close <= open) close += 24 * 60;
    if (open > 1440 || close > 1440 + 6 * 60) return null;
    return { open, close };
  }
  const o = OPEN_ENDED.exec(token);
  if (o) {
    const open = Number(o[1]) * 60 + Number(o[2]);
    return { open, close: 24 * 60 };
  }
  return null;
}

export function parseOpeningHours(raw: string): WeeklyHours | null {
  const text = raw.trim();
  if (!text) return null;
  if (text === '24/7') return allWeek({ open: 0, close: 1440 });

  const week = emptyWeek();
  let touched = false;

  for (const group of text.split(';')) {
    let days: number[] | null = null;
    let sawRanges = false;
    const tokens = group
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    for (const token of tokens) {
      const parts = token.split(/\s+/);
      const first = parts[0]!;
      if (DAY_SPEC.test(first)) {
        if (sawRanges) {
          // A new day spec after ranges begins a new rule inside the same group.
          days = null;
          sawRanges = false;
        }
        const expanded = expandDays(first);
        if (expanded === null) return null;
        days = [...(days ?? []), ...expanded];
        for (const rest of parts.slice(1)) {
          if (rest === 'off' || rest === 'closed') {
            sawRanges = true;
            touched = true;
            continue;
          }
          const range = parseRange(rest);
          if (!range) return null;
          for (const d of days) week[d]!.push(range);
          sawRanges = true;
          touched = true;
        }
        continue;
      }
      if (first === 'off' || first === 'closed') {
        sawRanges = true;
        touched = true;
        continue;
      }
      const range = parseRange(token);
      if (!range) return null;
      const target = days ?? [0, 1, 2, 3, 4, 5, 6];
      for (const d of target) week[d]!.push(range);
      sawRanges = true;
      touched = true;
    }
  }

  return touched ? week : null;
}

export interface LocalTime {
  /** 0 = Sunday. */
  day: number;
  /** Minutes since local midnight. */
  minutes: number;
}

/** Local day and minutes for an instant in a timezone. */
export function localTime(at: Date, timezone: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Day of week (0 = Sunday) for a YYYY-MM-DD calendar date. */
export function dayOfWeek(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/**
 * Is the venue open at `minutes` on `day`, staying open at least `minStayMinutes` more?
 * Intervals that run past midnight on the previous day count too.
 */
export function isOpenAt(
  hours: WeeklyHours,
  day: number,
  minutes: number,
  minStayMinutes = 60,
): boolean {
  const fits = (iv: OpenInterval, m: number) => m >= iv.open && m + minStayMinutes <= iv.close;
  if (hours[day]!.some((iv) => fits(iv, minutes))) return true;
  const prev = (day + 6) % 7;
  return hours[prev]!.some((iv) => iv.close > 1440 && fits(iv, minutes + 1440));
}

/** Human form for logs, e.g. "11:00-22:00". */
export function formatInterval(iv: OpenInterval): string {
  const f = (m: number) =>
    `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `${f(iv.open)}-${f(iv.close)}`;
}
