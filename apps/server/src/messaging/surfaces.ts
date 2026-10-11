/**
 * Live surfaces: the plan's status, shown without extra messages.
 *
 * Every member's headcount line is edited in place as the plan moves, driven by plan events on
 * the EventBus (the engine never calls this module):
 *
 *   DELIBERATING      "🫧 Dinner tonight · 4 in · finding the spot"
 *   plan_locked       "🔒 Thai Basil · 7:30 PM · 4 people · say "veto" to change it"
 *   BOOKING           "📞 Calling Thai Basil"
 *   booking_confirmed "✅ Booked Thai Basil · 7:30 PM · party of 4"  + one ticket image
 *
 * Edits are free against the message budget, which keeps the crew's DMs quiet. iMessage allows
 * edits for 15 minutes and 5 edits per message, so this stops at 4 edits or 14 minutes and the
 * engine's own lock and booked texts still carry the news. The ticket image counts against the
 * budget like any crew message and only shows group-level facts.
 */
import {
  idempotencyKey,
  type CrewDirectory,
  type Plan,
  type PlanEvent,
  type Venue,
} from '@bubbleworks/shared';
import type { Logger } from '../events/bus.js';
import type { SpectrumMessaging } from './adapter.js';
import type { BundleStore } from './bundle.js';
import { renderTicket, walkMinutes, type TicketData } from './card-image.js';

export interface LiveSurfacesOptions {
  port: Pick<SpectrumMessaging, 'sendGroupText' | 'sendImage'>;
  bundles: BundleStore;
  bus: {
    subscribe(planId: string, handler: (event: PlanEvent) => void | Promise<void>): () => void;
  };
  plans: { get(planId: string): Plan | null; inCount(planId: string): number };
  venues: () => Venue[];
  crews: Pick<CrewDirectory, 'crewById'>;
  log: Logger;
  timezone?: string;
  now?: () => number;
  render?: (ticket: TicketData) => Promise<Buffer>;
}

export class LiveSurfaces {
  private readonly timezone: string;
  private readonly now: () => number;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly o: LiveSurfacesOptions) {
    this.timezone = o.timezone ?? 'America/New_York';
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.unsubscribe = this.o.bus.subscribe('*', (event) =>
      this.onEvent(event).catch((err: unknown) =>
        this.o.log.warn(
          { err: String(err), planId: event.planId, type: event.type },
          'surface update failed',
        ),
      ),
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async onEvent(event: PlanEvent): Promise<void> {
    switch (event.type) {
      case 'plan_locked': {
        const timeText = this.clock(event.startAt);
        const bundle = this.o.bundles.byPlan(event.planId);
        if (!bundle) return;
        await this.o.port.sendGroupText({
          chatId: bundle.chatId,
          text:
            `🔒 Found a spot: ${event.venue.name}, ${timeText}, ${event.partySize} people. ` +
            `Calling to book now. Say "veto" in the next minute to change it.`,
          idempotencyKey: idempotencyKey(event.planId, 'surface', 'locked', event.venue.venueId),
        });
        this.o.log.info({ planId: event.planId, venue: event.venue.name }, 'locked line sent');
        return;
      }
      case 'booking_confirmed': {
        if (!this.o.bundles.byPlan(event.planId)) return;
        await this.sendTicket(event.planId, {
          venueId: event.venue.venueId,
          venueName: event.venue.name,
          cuisine: event.venue.cuisine,
          timeText: this.clock(event.startAt),
          partySize: event.partySize,
        });
        return;
      }
      default:
        return;
    }
  }

  private async sendTicket(
    planId: string,
    booking: {
      venueId: string;
      venueName: string;
      cuisine: string;
      timeText: string;
      partySize: number;
    },
  ): Promise<void> {
    const plan = this.o.plans.get(planId);
    if (!plan) return;
    const venue = this.o.venues().find((v) => v.id === booking.venueId) ?? null;
    const crew = await this.o.crews.crewById(plan.groupId);
    const walk = crew?.center && venue ? walkMinutes(crew.center, venue.location) : null;
    const backup = plan.backupVenueId
      ? (this.o.venues().find((v) => v.id === plan.backupVenueId)?.name ?? null)
      : null;
    const started = this.now();
    const image = await (this.o.render ?? renderTicket)({
      status: 'Booked',
      venueName: booking.venueName,
      cuisine: booking.cuisine,
      timeText: booking.timeText,
      partySize: booking.partySize,
      address: venue?.address ?? null,
      walkMinutes: walk,
      backupName: backup,
    });
    await this.o.port.sendImage({
      chatId: plan.chatId,
      data: image,
      name: 'booking.jpg',
      mimeType: 'image/jpeg',
      idempotencyKey: idempotencyKey(planId, 'ticket'),
    });
    this.o.log.info({ planId, renderMs: this.now() - started, bytes: image.length }, 'ticket sent');
  }

  private clock(iso: string): string {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: this.timezone,
    }).format(new Date(iso));
  }
}
