import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@bubbleworks/shared';
import { bookings } from '../db/schema.js';
import { signBookingToken } from '../doers/ics.js';
import type { Runtime } from '../runtime.js';
import { INTENT, testRuntime } from '../test-helpers.js';
import {
  loadTicketPage,
  mapsUrl,
  ticketPageHtml,
  ticketTime,
  type TicketPageData,
} from './ticket-page.js';

const ALPHA_PIE = 'venue_osm_n13256222785';
const CHIPOTLE = 'venue_osm_w44343155';
const START = '2026-10-11T23:00:00.000Z'; // 7:00 PM New York, Sunday Oct 11

const DATA: TicketPageData = {
  venueName: 'Thai Basil',
  address: '108 E Franklin St',
  mapsUrl:
    'https://www.google.com/maps/search/?api=1&query=Thai%20Basil%2C%20108%20E%20Franklin%20St',
  timeText: '7:00 PM, Sat Oct 11',
  partySize: 4,
  reservationName: 'Pranav',
  confirmationCode: null,
  members: ['Pranav', 'Mahil'],
  icsUrl: 'https://api.example/ics/tok.ics',
  backupName: 'Bonchon',
};

describe('ticketPageHtml', () => {
  it('shows the venue, maps link, calendar link, party, and who is coming', () => {
    const html = ticketPageHtml(DATA);
    expect(html).toContain('<h1>Thai Basil</h1>');
    expect(html).toContain('108 E Franklin St');
    expect(html).toContain(
      'href="https://www.google.com/maps/search/?api=1&amp;query=Thai%20Basil%2C%20108%20E%20Franklin%20St"',
    );
    expect(html).toContain('href="https://api.example/ics/tok.ics"');
    expect(html).toContain('7:00 PM, Sat Oct 11');
    expect(html).toContain('Table for 4');
    expect(html).toContain('<li>Pranav</li><li>Mahil</li>');
    expect(html).toContain('Backup spot: Bonchon');
    expect(html).toContain('prefers-color-scheme: dark');
  });

  it('escapes HTML from venue and member names', () => {
    const html = ticketPageHtml({
      ...DATA,
      venueName: '<script>alert(1)</script>',
      members: ['Bob "the" <b>'],
      reservationName: "O'Neil & co",
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Bob &quot;the&quot; &lt;b&gt;');
    expect(html).toContain('O&#39;Neil &amp; co');
  });

  it('renders a not-found page for a bad link', () => {
    expect(ticketPageHtml(null)).toContain('Ticket not found');
  });
});

describe('ticket helpers', () => {
  it('formats the local time with the day', () => {
    expect(ticketTime(START, 'America/New_York')).toBe('7:00 PM, Sun Oct 11');
  });

  it('links Google Maps by name and address, or by coordinates', () => {
    expect(mapsUrl({ name: 'A&B', address: '1 Main St', lat: 1, lng: 2 })).toBe(
      'https://www.google.com/maps/search/?api=1&query=A%26B%2C%201%20Main%20St',
    );
    expect(mapsUrl({ name: 'A', address: null, lat: 35.9, lng: -79.05 })).toBe(
      'https://www.google.com/maps/search/?api=1&query=35.9%2C-79.05',
    );
  });
});

describe('loadTicketPage', () => {
  let rt: Runtime;
  beforeEach(() => {
    rt = testRuntime();
  });
  afterEach(() => rt.close());

  function book(): string {
    const plan = rt.plans.create({
      groupId: 'group_demo',
      chatId: 'crew:group_demo',
      intent: INTENT,
      createdByUserId: 'user_ava',
    });
    rt.plans.upsertMember(plan.id, 'user_ava', 'in');
    rt.plans.upsertMember(plan.id, 'user_ben', 'in');
    rt.plans.upsertMember(plan.id, 'user_chloe', 'out');
    rt.plans.upsertMember(plan.id, 'user_dev', 'represented', true);
    const id = newId('booking');
    const at = new Date().toISOString();
    rt.db
      .insert(bookings)
      .values({
        id,
        planId: plan.id,
        venueId: ALPHA_PIE,
        backupVenueId: CHIPOTLE,
        status: 'booked',
        partySize: 3,
        startAt: START,
        reservationName: 'Ava',
        confirmationCode: 'BW42',
        idempotencyKey: `k-${id}`,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    return id;
  }

  const deps = () => ({
    db: rt.db,
    plans: rt.plans,
    crews: rt.crews,
    publicBaseUrl: 'https://bw.test/',
    linkSecret: 'secret',
  });

  it('loads a signed booking with its attending members and backup', async () => {
    const id = book();
    const token = signBookingToken(id, 'secret');
    const data = await loadTicketPage(deps(), token);
    expect(data).toMatchObject({
      venueName: 'Alpha Pie',
      timeText: '7:00 PM, Sun Oct 11',
      partySize: 3,
      reservationName: 'Ava',
      confirmationCode: 'BW42',
      icsUrl: `https://bw.test/ics/${token}.ics`,
    });
    expect(data!.mapsUrl).toMatch(
      /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=Alpha%20Pie/,
    );
    expect(data!.members).toHaveLength(3);
    expect(data!.backupName).toBeTruthy();
  });

  it('refuses a token signed with another secret', async () => {
    const id = book();
    expect(await loadTicketPage(deps(), signBookingToken(id, 'other'))).toBeNull();
    expect(await loadTicketPage(deps(), 'garbage')).toBeNull();
  });
});
