import Database from 'better-sqlite3';
import type { Plan, PlanEvent, Venue } from '@bubbleworks/shared';
import { DEMO_GROUP } from '@bubbleworks/shared/fakes';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../events/bus.js';
import { BundleStore, headcountText } from './bundle.js';
import { walkMinutes } from './card-image.js';
import { LiveSurfaces, MAX_EDITS } from './surfaces.js';

const PLAN = 'plan_1';
const CREW = DEMO_GROUP.chatId;
const at = '2026-10-10T22:00:00.000Z';
const VENUE: Venue = {
  id: 'venue_thai',
  name: 'Thai Basil',
  cuisine: 'thai',
  dietTags: [],
  accessibilityTags: [],
  priceLevel: 2,
  typicalCostUsd: 20,
  hours: [[], [], [], [], [], [], []],
  phone: '+19195550100',
  location: { lat: 35.9132, lng: -79.0558 },
  address: '108 E Franklin St',
  neighborhood: null,
  isDemo: false,
};

function setup(options: { createdAgoMs?: number } = {}) {
  const bundles = new BundleStore(new Database(':memory:'));
  bundles.save({
    planId: PLAN,
    chatId: CREW,
    headcountMessageId: 'grp:plan_1:bundle:headcount',
    pollId: null,
    organizerName: 'Pranav',
    meal: 'dinner',
    closesAt: at,
  });
  const edits: Array<{ chatId: string; messageId: string; text: string }> = [];
  const images: Array<{ chatId: string; name: string; idempotencyKey: string }> = [];
  const rendered: unknown[] = [];
  let handler: ((e: PlanEvent) => void | Promise<void>) | null = null;
  const savedAt = Date.now();
  const surfaces = new LiveSurfaces({
    port: {
      editMessage: async (input) => void edits.push(input),
      sendImage: async (input) => {
        images.push({
          chatId: input.chatId,
          name: input.name,
          idempotencyKey: input.idempotencyKey,
        });
        return { messageId: 'grp:ticket', deduplicated: false };
      },
    },
    bundles,
    bus: { subscribe: (_planId, h) => ((handler = h), () => (handler = null)) },
    plans: {
      get: () => ({ id: PLAN, groupId: DEMO_GROUP.id, chatId: CREW, backupVenueId: null }) as Plan,
      inCount: () => 4,
    },
    venues: () => [VENUE],
    crews: { crewById: async () => DEMO_GROUP },
    log: silentLogger,
    now: () => savedAt + (options.createdAgoMs ?? 0),
    render: async (ticket) => {
      rendered.push(ticket);
      return Buffer.from('jpg');
    },
  });
  surfaces.start();
  const emit = async (event: Record<string, unknown>) =>
    handler?.({ planId: PLAN, at, ...event } as unknown as PlanEvent);
  return { edits, images, rendered, emit };
}

describe('LiveSurfaces', () => {
  it('edits the headcount line through the plan and sends one ticket at booking', async () => {
    const { edits, images, rendered, emit } = setup();
    await emit({ type: 'plan_state_changed', from: 'GATHERING', to: 'DELIBERATING' });
    await emit({
      type: 'plan_locked',
      venue: { venueId: VENUE.id, name: VENUE.name, cuisine: 'thai' },
      backup: null,
      startAt: '2026-10-10T23:30:00.000Z',
      partySize: 4,
    });
    await emit({ type: 'plan_state_changed', from: 'LOCKED', to: 'BOOKING' });
    await emit({
      type: 'booking_confirmed',
      bookingId: 'b1',
      venue: { venueId: VENUE.id, name: VENUE.name, cuisine: 'thai' },
      startAt: '2026-10-10T23:30:00.000Z',
      partySize: 4,
      reservationName: 'Pranav',
    });

    expect(edits.map((e) => e.text)).toEqual([
      '🫧 Dinner · 4 in · finding the spot',
      '🔒 Thai Basil · 7:30 PM · 4 people · say "veto" to change it',
      '📞 Calling Thai Basil',
      '✅ Booked Thai Basil · 7:30 PM · party of 4',
    ]);
    expect(
      edits.every((e) => e.chatId === CREW && e.messageId === 'grp:plan_1:bundle:headcount'),
    ).toBe(true);
    expect(images).toEqual([
      { chatId: CREW, name: 'booking.jpg', idempotencyKey: 'plan_1:ticket' },
    ]);
    expect(rendered[0]).toMatchObject({
      status: 'Booked',
      venueName: 'Thai Basil',
      partySize: 4,
      address: '108 E Franklin St',
      timeText: '7:30 PM',
    });
  });

  it(`stops editing after ${MAX_EDITS} edits (iMessage allows 5)`, async () => {
    const { edits, emit } = setup();
    for (let n = 0; n < 6; n++) {
      await emit({
        type: 'plan_locked',
        venue: { venueId: VENUE.id, name: `Place ${n}`, cuisine: 'thai' },
        backup: null,
        startAt: '2026-10-10T23:30:00.000Z',
        partySize: 4,
      });
    }
    expect(edits).toHaveLength(MAX_EDITS);
  });

  it('stops editing once the line is older than the iMessage edit window, but still sends the ticket', async () => {
    const { edits, images, emit } = setup({ createdAgoMs: 20 * 60_000 });
    await emit({
      type: 'booking_confirmed',
      bookingId: 'b1',
      venue: { venueId: VENUE.id, name: VENUE.name, cuisine: 'thai' },
      startAt: '2026-10-10T23:30:00.000Z',
      partySize: 4,
      reservationName: 'Pranav',
    });
    expect(edits).toHaveLength(0);
    expect(images).toHaveLength(1);
  });

  it('ignores plans it never sent a bundle for', async () => {
    const { edits, emit } = setup();
    await emit({
      type: 'plan_state_changed',
      from: 'GATHERING',
      to: 'DELIBERATING',
      planId: 'plan_other',
    });
    expect(edits).toHaveLength(0);
  });
});

describe('opt-out headcount', () => {
  it('tells people they are counted in unless they say out', () => {
    expect(
      headcountText({
        planId: PLAN,
        chatId: CREW,
        organizerName: 'Pranav',
        meal: 'dinner',
        cuisinePoll: null,
        headcount: {
          closesAt: '2026-10-10T23:05:00.000Z',
          timezone: 'America/New_York',
          mode: 'opt_out',
        },
        pageUrl: null,
      }),
    ).toBe(
      `🫧 Pranav is planning dinner tonight. You're counted in, reply "out" if you can't make it. Locking it in at 7:05.`,
    );
  });
});

describe('walkMinutes', () => {
  it('estimates walking time with a street factor', () => {
    expect(walkMinutes({ lat: 35.9097, lng: -79.0475 }, { lat: 35.9132, lng: -79.0558 })).toBe(14);
    expect(walkMinutes({ lat: 0, lng: 0 }, { lat: 0, lng: 0 })).toBe(1);
  });
});
