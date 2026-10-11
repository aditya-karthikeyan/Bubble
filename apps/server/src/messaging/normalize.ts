/**
 * Spectrum message -> RawInbound. Pure and validated with zod, so the adapter never touches
 * an SDK object it has not checked.
 *
 * Only the fields Bubbleworks uses are read. Everything else (read receipts, typing, group
 * events, attachments) normalizes to null and is dropped.
 */
import { z } from 'zod';

export type RawInbound =
  | {
      kind: 'location';
      providerId: string;
      phone: string;
      lat: number;
      lng: number;
      at: string;
    }
  | {
      kind: 'text';
      providerId: string;
      phone: string;
      text: string;
      replyToMessageId?: string;
      at: string;
    }
  | {
      /** The person edited an earlier message; `editOf` is that message's provider id. */
      kind: 'edit';
      providerId: string;
      phone: string;
      editOf: string;
      text: string;
      at: string;
    }
  | {
      kind: 'reaction';
      providerId: string;
      phone: string;
      targetMessageId: string;
      emoji: string;
      removed: boolean;
      at: string;
    }
  | {
      kind: 'poll_vote';
      providerId: string;
      phone: string;
      /** Provider id of the poll message the vote belongs to. */
      pollMessageId: string;
      optionLabel: string;
      selected: boolean;
      at: string;
    };

const Target = z.object({ id: z.string().min(1) });

const Content = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('reply'),
    target: Target,
    content: z.object({ type: z.string(), text: z.string().optional() }),
  }),
  z.object({ type: z.literal('reaction'), emoji: z.string().min(1), target: Target }),
  z.object({
    type: z.literal('poll_option'),
    option: z.object({ title: z.string() }),
    selected: z.boolean(),
  }),
]);

const Envelope = z.object({
  id: z.string().min(1),
  direction: z.enum(['inbound', 'outbound']),
  timestamp: z.date(),
  space: z.object({ id: z.string().min(1) }),
  content: z.object({ type: z.string() }).loose(),
});

/** Phone behind a DM chat id. Terminal spaces are named after the phone directly. */
export function phoneFromChatId(chatId: string): string {
  return chatId.startsWith('any;-;') ? chatId.slice('any;-;'.length) : chatId;
}

/** Poll vote ids are "<pollMessageGuid>:<sender>:<optionId>:<action>:<time>". */
export function pollMessageIdFromVoteId(voteId: string): string | null {
  const head = voteId.split(':')[0];
  return head ? head : null;
}

export function normalize(message: unknown): RawInbound | null {
  const envelope = Envelope.safeParse(message);
  if (!envelope.success || envelope.data.direction !== 'inbound') return null;
  const content = Content.safeParse(envelope.data.content);
  if (!content.success) return null;

  const { id, timestamp, space } = envelope.data;
  const base = { providerId: id, phone: phoneFromChatId(space.id), at: timestamp.toISOString() };
  const c = content.data;

  switch (c.type) {
    case 'text': {
      if (!c.text.trim()) return null;
      // Our spectrum patch delivers iMessage edits as "<original guid>:edit:<sequence>".
      const edit = /^(.+):edit:\d+$/.exec(id);
      return edit
        ? { kind: 'edit', ...base, editOf: edit[1]!, text: c.text }
        : { kind: 'text', ...base, text: c.text };
    }
    case 'reply':
      return c.content.text?.trim()
        ? { kind: 'text', ...base, text: c.content.text, replyToMessageId: c.target.id }
        : null;
    case 'reaction':
      return {
        kind: 'reaction',
        ...base,
        targetMessageId: c.target.id,
        emoji: c.emoji,
        removed: false,
      };
    case 'poll_option': {
      const pollMessageId = pollMessageIdFromVoteId(id);
      if (!pollMessageId) return null;
      return {
        kind: 'poll_vote',
        ...base,
        pollMessageId,
        optionLabel: c.option.title,
        selected: c.selected,
      };
    }
  }
}

/** Attachments that are Apple location pins ("Share" -> Location sends CL.loc.vcf). */
export function isLocationAttachment(content: unknown): content is {
  type: 'attachment';
  name?: string;
  mimeType?: string;
  read: () => Promise<Buffer>;
} {
  if (!content || typeof content !== 'object') return false;
  const c = content as { type?: unknown; name?: unknown; mimeType?: unknown; read?: unknown };
  if (c.type !== 'attachment' || typeof c.read !== 'function') return false;
  const name = typeof c.name === 'string' ? c.name.toLowerCase() : '';
  const mime = typeof c.mimeType === 'string' ? c.mimeType.toLowerCase() : '';
  return name.endsWith('.loc.vcf') || mime.includes('vlocation');
}

/**
 * Coordinates from a location pin's vCard or any Apple/Google maps link or geo: URI.
 * Returns null when nothing valid is found.
 */
export function parseCoordinates(text: string): { lat: number; lng: number } | null {
  const patterns = [
    /[?&](?:ll|q|sll)=(-?\d{1,3}(?:\.\d+)?)(?:\\?,|%2C)(-?\d{1,3}(?:\.\d+)?)/i,
    /geo:(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/i,
    /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }
  return null;
}
