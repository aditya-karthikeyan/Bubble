/**
 * The ticket page: what the booked Mini App card opens. Served at /t/<token>, where the token is
 * the same HMAC-signed booking token as the .ics link (doers/ics.ts), so it cannot be guessed and
 * the page links straight to /ics/<token>.ics. It shows group-level facts only: venue, address,
 * time, party size, the reservation name, who is coming (display names), and the backup spot.
 */
import type { CrewDirectory, PlanMember } from '@bubbleworks/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { bookings, venues } from '../db/schema.js';
import { verifyBookingToken } from '../doers/ics.js';

export interface TicketPageData {
  venueName: string;
  address: string | null;
  mapsUrl: string;
  /** Local time, e.g. "7:00 PM, Sat Oct 11". */
  timeText: string;
  partySize: number;
  reservationName: string;
  confirmationCode: string | null;
  members: string[];
  icsUrl: string;
  backupName: string | null;
}

export interface TicketPageDeps {
  db: Db;
  plans: { members(planId: string): PlanMember[] };
  crews: Pick<CrewDirectory, 'userById'>;
  publicBaseUrl: string;
  linkSecret: string;
  timezone?: string;
}

/** The ticket for a signed token, or null when the token is forged or the booking is gone. */
export async function loadTicketPage(
  deps: TicketPageDeps,
  token: string,
): Promise<TicketPageData | null> {
  const bookingId = verifyBookingToken(token, deps.linkSecret);
  if (!bookingId) return null;
  const row = deps.db
    .select({ b: bookings, v: venues })
    .from(bookings)
    .innerJoin(venues, eq(venues.id, bookings.venueId))
    .where(eq(bookings.id, bookingId))
    .get();
  if (!row) return null;
  const backup = row.b.backupVenueId
    ? deps.db
        .select({ name: venues.name })
        .from(venues)
        .where(eq(venues.id, row.b.backupVenueId))
        .get()
    : undefined;
  const members: string[] = [];
  for (const m of deps.plans.members(row.b.planId)) {
    if (m.status !== 'in' && m.status !== 'represented') continue;
    const user = await deps.crews.userById(m.userId);
    if (user) members.push(user.displayName);
  }
  const base = deps.publicBaseUrl.replace(/\/$/, '');
  return {
    venueName: row.v.name,
    address: row.v.address,
    mapsUrl: mapsUrl(row.v),
    timeText: ticketTime(row.b.startAt, deps.timezone ?? 'America/New_York'),
    partySize: row.b.partySize,
    reservationName: row.b.reservationName,
    confirmationCode: row.b.confirmationCode,
    members,
    icsUrl: `${base}/ics/${token}.ics`,
    backupName: backup?.name ?? null,
  };
}

/** Google Maps search link: by name and address when there is one, else by coordinates. */
export function mapsUrl(v: {
  name: string;
  address: string | null;
  lat: number;
  lng: number;
}): string {
  const query = v.address ? `${v.name}, ${v.address}` : `${v.lat},${v.lng}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** "7:00 PM, Sat Oct 11" in the given zone. */
export function ticketTime(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(d);
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone,
  })
    .format(d)
    .replace(',', '');
  return `${time}, ${day}`;
}

export function ticketPageHtml(data: TicketPageData | null): string {
  if (!data) return page('Ticket not found', notFound());
  const e = escapeHtml;
  const venue = e(data.venueName);
  const who = data.members.length
    ? `<ul class="who">${data.members.map((n) => `<li>${e(n)}</li>`).join('')}</ul>`
    : '';
  const rows = [
    row('When', e(data.timeText)),
    row('Party', `Table for ${data.partySize}`),
    row('Name', e(data.reservationName)),
    data.confirmationCode ? row('Confirmation', e(data.confirmationCode)) : '',
  ].join('');
  const body = `
  <p class="status">Booked ✅</p>
  <h1>${venue}</h1>
  ${data.address ? `<p class="addr">${e(data.address)}</p>` : ''}
  <div class="card">
    <dl>${rows}</dl>
    ${who ? `<p class="label">Who's coming</p>${who}` : ''}
  </div>
  <a class="button" href="${e(data.mapsUrl)}">Open in Maps</a>
  <a class="button secondary" href="${e(data.icsUrl)}">Add to calendar</a>
  ${data.backupName ? `<p class="fine">Backup spot: ${e(data.backupName)}</p>` : ''}
  <p class="fine">Booked by your bubbles.</p>`;
  return page(`${data.venueName} · ${data.timeText}`, body);
}

function row(label: string, value: string): string {
  return `<div class="row"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function notFound(): string {
  return `
  <h1>Ticket not found</h1>
  <p class="addr">That link doesn't match a booking anymore. The booked message in your chat has the latest details.</p>`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Bubbleworks</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif; background: radial-gradient(120% 90% at 50% 0%, #cfe6ff 0%, #f6f9ff 55%, #ffffff 100%); color: #10203a; min-height: 100vh; }
  @media (prefers-color-scheme: dark) { body { background: radial-gradient(120% 90% at 50% 0%, #15304f 0%, #0b1526 55%, #070d18 100%); color: #e9f0fb; } .card { background: rgba(20,32,52,.85) !important; } .row { border-color: #2a3d5c !important; } .who li { background: #0f1b2e !important; border-color: #2a3d5c !important; } a.secondary { background: rgba(31,111,229,.18) !important; color: #9cc4ff !important; } }
  .wrap { max-width: 440px; margin: 0 auto; padding: 40px 16px 64px; }
  .orb { width: 48px; height: 48px; border-radius: 50%; background: radial-gradient(circle at 30% 30%, #fff, #8fc3ff 55%, #4a8ff0); box-shadow: 0 10px 30px rgba(74,143,240,.35); margin-bottom: 14px; }
  .status { margin: 0 0 4px; font-weight: 600; font-size: 14px; letter-spacing: .02em; opacity: .8; }
  h1 { font-size: 30px; margin: 0 0 4px; letter-spacing: -.01em; overflow-wrap: anywhere; }
  .addr { margin: 0 0 18px; opacity: .8; }
  .card { background: rgba(255,255,255,.8); backdrop-filter: blur(14px); border-radius: 18px; padding: 6px 20px 16px; box-shadow: 0 12px 40px rgba(16,32,58,.12); margin-bottom: 16px; }
  dl { margin: 0; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid #dfe8f5; }
  dt { opacity: .7; }
  dd { margin: 0; font-weight: 600; text-align: right; overflow-wrap: anywhere; }
  .label { font-size: 13px; opacity: .7; margin: 14px 0 8px; }
  .who { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
  .who li { padding: 6px 12px; border-radius: 999px; background: #eef4fd; border: 1px solid #dfe8f5; font-size: 14px; }
  a.button { display: block; text-align: center; text-decoration: none; margin-top: 12px; font-weight: 600; padding: 14px; border-radius: 14px; background: #1f6fe5; color: #fff; }
  a.secondary { background: rgba(31,111,229,.1); color: #1f6fe5; }
  .fine { font-size: 13px; opacity: .7; margin-top: 16px; }
</style></head>
<body><div class="wrap">
  <div class="orb" aria-hidden="true"></div>
  ${body}
</div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
