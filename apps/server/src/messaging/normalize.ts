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
      kind: 'text';
      providerId: string;
      phone: string;
      text: string;
      replyToMessageId?: string;
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
    case 'text':
      return c.text.trim() ? { kind: 'text', ...base, text: c.text } : null;
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
