/** Venue-local wall-clock times: what the agent says ("7:00 PM") and what it hears back. */

function partsIn(date: Date, timeZone: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** Milliseconds the zone is ahead of UTC at that instant. */
function offsetMs(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(
    p['year']!,
    p['month']! - 1,
    p['day']!,
    p['hour']!,
    p['minute']!,
    p['second']!,
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** "7:00 PM", with a plain space (Intl emits a narrow no-break space). */
export function formatLocalTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
    .format(new Date(iso))
    .replace(/\s+/g, ' ');
}

export function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

/**
 * "7:15 PM", "7:15", "7 pm", "19:15" on the same local day as referenceIso, as an ISO instant.
 * Hours 1 to 11 without am/pm read as evening, since the caller books dinner. Null when unreadable.
 */
export function parseLocalTime(
  text: string,
  referenceIso: string,
  timeZone: string,
): string | null {
  const m = /(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?/i.exec(text.trim());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3]?.toLowerCase();
  if (hour > 23 || minute > 59) return null;
  if (meridiem === 'p' && hour < 12) hour += 12;
  else if (meridiem === 'a' && hour === 12) hour = 0;
  else if (!meridiem && hour >= 1 && hour <= 11) hour += 12;

  const day = partsIn(new Date(referenceIso), timeZone);
  const guess = Date.UTC(day['year']!, day['month']! - 1, day['day']!, hour, minute);
  // Two passes settle the offset across a DST change.
  let instant = guess - offsetMs(new Date(guess), timeZone);
  instant = guess - offsetMs(new Date(instant), timeZone);
  return new Date(instant).toISOString();
}
