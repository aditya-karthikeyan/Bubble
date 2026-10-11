/**
 * Calendar invite (.ics) for a booking. Served by the server at /ics/<signed token>.ics so the
 * Inviter can send a short link that iMessage previews and iOS opens as "Add to Calendar"
 * (MessagingPort has no attachment send).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface IcsEvent {
  uid: string;
  start: Date;
  minutes: number;
  title: string;
  location: string | null;
  description: string;
  now: Date;
}

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
const esc = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** RFC 5545, UTC times, CRLF lines, folded at 75 octets. */
export function buildIcs(e: IcsEvent): string {
  const end = new Date(e.start.getTime() + e.minutes * 60_000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Bubbleworks//Inviter//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${e.uid}@bubbleworks`,
    `DTSTAMP:${stamp(e.now)}`,
    `DTSTART:${stamp(e.start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(e.title)}`,
    ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
    `DESCRIPTION:${esc(e.description)}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT45M',
    'ACTION:DISPLAY',
    `DESCRIPTION:${esc(e.title)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  let limit = 75;
  while (Buffer.byteLength(rest, 'utf8') > limit) {
    let cut = limit;
    while (Buffer.byteLength(rest.slice(0, cut), 'utf8') > limit) cut--;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    limit = 74; // continuation lines start with a space
  }
  parts.push(rest);
  return parts.join('\r\n ');
}

export function signBookingToken(bookingId: string, secret: string): string {
  const mac = createHmac('sha256', secret)
    .update(`ics:${bookingId}`)
    .digest('base64url')
    .slice(0, 16);
  return `${Buffer.from(bookingId).toString('base64url')}.${mac}`;
}

export function verifyBookingToken(token: string, secret: string): string | null {
  const [idPart, mac] = token.split('.');
  if (!idPart || !mac) return null;
  const bookingId = Buffer.from(idPart, 'base64url').toString('utf8');
  const expected = Buffer.from(signBookingToken(bookingId, secret).split('.')[1]!);
  const got = Buffer.from(mac);
  return got.length === expected.length && timingSafeEqual(got, expected) ? bookingId : null;
}
