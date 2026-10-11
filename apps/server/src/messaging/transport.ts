/**
 * Transport: the only code that talks to spectrum-ts. The adapter above it deals in chat ids,
 * provider message ids, and RawInbound events, so it can be unit tested with a fake transport.
 *
 * Two providers:
 * - imessage: Photon cloud iMessage (Pro shared pool). Holds the real line: LINE LOCK first.
 * - terminal: Spectrum's local TUI. It skips polls, rich links, and edits, so this transport
 *   renders them as text: numbered poll options (reply with a number to vote), links as
 *   "title\nurl", edits re-sent as a new line, Mini App cards as "[card: caption — url]".
 */
import { randomUUID } from 'node:crypto';
import {
  Spectrum,
  app,
  attachment,
  edit,
  poll,
  reaction,
  reply,
  richlink,
  text,
  type Message,
  type Space,
} from 'spectrum-ts';
import {
  customizedMiniApp,
  imessage,
  type CustomizedMiniAppLayout,
} from 'spectrum-ts/providers/imessage';
import { terminal } from 'spectrum-ts/providers/terminal';
import { isLocationAttachment, normalize, parseCoordinates, type RawInbound } from './normalize.js';

export type OutContent =
  | { kind: 'text'; text: string; replyToMessageId?: string }
  | { kind: 'poll'; question: string; options: string[] }
  | { kind: 'link'; url: string; title: string }
  | { kind: 'image'; data: Buffer; name: string; mimeType: string }
  | ({ kind: 'mini_app' } & MiniAppCard);

/**
 * A native iMessage Mini App card. Tapping it opens `url` inside Photon's Spectrum iMessage app.
 * The layout is what the bubble shows; `summary` is the one-line fallback (notifications,
 * conversation list, devices without the app).
 */
export interface MiniAppCard {
  url: string;
  caption: string;
  subcaption?: string;
  trailingCaption?: string;
  trailingSubcaption?: string;
  summary: string;
  /** JPEG. */
  image?: Buffer;
  imageTitle?: string;
  imageSubtitle?: string;
}

/**
 * Spectrum's own iMessage extension: the card opens in it, so nobody installs anything of ours.
 * Same identity spectrum-ts uses for its `app()` content; the App Store id points phones
 * without the extension at it.
 */
const SPECTRUM_EXTENSION = {
  teamId: 'P8XT6232SL',
  extensionBundleId: 'codes.photon.Spectrum.MessagesExtension',
  appStoreId: 6777616651,
} as const;

export interface Transport {
  readonly provider: 'imessage' | 'terminal';
  start(onInbound: (event: RawInbound) => void): Promise<void>;
  send(chatId: string, content: OutContent): Promise<{ messageId: string }>;
  edit(chatId: string, messageId: string, text: string): Promise<void>;
  react(chatId: string, messageId: string, emoji: string): Promise<void>;
  typing(chatId: string, on: boolean): Promise<void>;
  stop(): Promise<void>;
}

type SpectrumApp = Awaited<ReturnType<typeof Spectrum>>;
type SpaceLike = Space;

export interface SpectrumTransportOptions {
  provider: 'imessage' | 'terminal';
  projectId?: string;
  projectSecret?: string;
  /** Terminal chats not named after a phone (chat-1, chat-2) speak as this phone. */
  terminalDefaultPhone?: string;
  /**
   * How links render on iMessage. "text" (default): "🫧 <title>: <url>", tap opens Safari with
   * nothing to install. "app": a generic iMessage app card, the only form that shows a preview
   * from the Photon shared line, but phones without the "Spectrum by Photon" iMessage app are
   * asked to download it first. "richlink": a bare URL bubble.
   */
  linkStyle?: 'text' | 'app' | 'richlink';
  log?: (obj: Record<string, unknown>, msg: string) => void;
}

/** A poll rendered as text on the terminal, waiting for a numeric reply. */
type TerminalPoll = { messageId: string; options: string[]; choice: string | null };

export class SpectrumTransport implements Transport {
  readonly provider: 'imessage' | 'terminal';
  private app: SpectrumApp | null = null;
  private getSpace: ((chatId: string) => Promise<SpaceLike>) | null = null;
  private readonly spaces = new Map<string, SpaceLike>();
  /** Outbound messages by id, so edits, reactions, and replies have a target. */
  private readonly sent = new Map<string, Message>();
  private readonly terminalPolls = new Map<string, TerminalPoll>();
  private loop: Promise<void> | null = null;

  constructor(private readonly options: SpectrumTransportOptions) {
    this.provider = options.provider;
  }

  async start(onInbound: (event: RawInbound) => void): Promise<void> {
    if (this.provider === 'imessage') {
      const { projectId, projectSecret } = this.options;
      if (!projectId || !projectSecret)
        throw new Error('imessage transport needs project credentials');
      const app = await Spectrum({
        projectId,
        projectSecret,
        providers: [imessage.config()],
        options: { logLevel: 'warn' },
      });
      const im = imessage(app);
      this.app = app;
      this.getSpace = (chatId) => im.space.get(chatId);
    } else {
      const app = await Spectrum({ providers: [terminal.config()], options: { logLevel: 'warn' } });
      const t = terminal(app);
      this.app = app;
      this.getSpace = (chatId) => t.space.get(chatId);
    }
    const app = this.app;
    this.loop = (async () => {
      for await (const [, message] of app.messages) {
        try {
          const location = await this.locationPin(message);
          if (location) {
            onInbound(location);
            continue;
          }
          for (const event of this.toInbound(message)) onInbound(event);
        } catch (err) {
          this.options.log?.({ err: String(err) }, 'inbound message dropped');
        }
      }
    })();
  }

  /** An Apple location pin (CL.loc.vcf) becomes a location event; anything else returns null. */
  private async locationPin(message: Message): Promise<RawInbound | null> {
    if (message.direction !== 'inbound' || !isLocationAttachment(message.content)) return null;
    const vcard = (await message.content.read()).toString('utf8');
    const coords = parseCoordinates(vcard);
    if (!coords) {
      this.options.log?.(
        { name: message.content.name ?? null },
        'location pin without coordinates',
      );
      return null;
    }
    const raw = message.space.id;
    const phone = raw.startsWith('any;-;') ? raw.slice('any;-;'.length) : raw;
    return {
      kind: 'location',
      providerId: message.id,
      phone,
      ...coords,
      at: message.timestamp.toISOString(),
    };
  }

  private toInbound(message: Message): RawInbound[] {
    const normalized = normalize(message);
    if (!normalized) {
      // A content kind we do not read yet (a shared location, a contact card, a sticker). Logged
      // so the next unknown kind can be added; message text is never logged.
      const c = message.content as { type?: unknown; name?: unknown; mimeType?: unknown };
      // Read receipts and typing are expected noise.
      if (message.direction === 'inbound' && c?.type !== 'read' && c?.type !== 'typing') {
        // For a "custom" balloon (a shared location, a contact card) log its shape, never any
        // text, so the next kind can be read.
        const shape =
          c?.type === 'custom'
            ? JSON.stringify(c, (k, v) =>
                k === 'text' || k === 'body' || typeof v === 'function' ? undefined : v,
              ).slice(0, 600)
            : null;
        this.options.log?.(
          {
            type: typeof c?.type === 'string' ? c.type : typeof c,
            name: typeof c?.name === 'string' ? c.name : null,
            mimeType: typeof c?.mimeType === 'string' ? c.mimeType : null,
            keys: c && typeof c === 'object' ? Object.keys(c) : [],
            shape,
          },
          'inbound content not understood',
        );
      }
      return [];
    }
    if (this.provider !== 'terminal') return [normalized];
    const fallbackPhone = this.options.terminalDefaultPhone;
    const event =
      !normalized.phone.startsWith('+') && fallbackPhone
        ? { ...normalized, phone: fallbackPhone }
        : normalized;
    if (event.kind !== 'text') return [event];

    // Terminal threaded replies carry replyTo as an extra field instead of reply content.
    const replyTo = (message as { replyTo?: { messageId?: string } }).replyTo?.messageId;
    const withReply = replyTo ? { ...event, replyToMessageId: replyTo } : event;

    // A bare number answers the open text poll in that chat.
    const open = this.terminalPolls.get(event.phone) ?? this.terminalPolls.get(message.space.id);
    const pick = /^\s*(\d+)\s*$/.exec(event.text);
    if (!open || !pick) return [withReply];
    const label = open.options[Number(pick[1]) - 1];
    if (!label) return [withReply];
    const votes: RawInbound[] = [];
    const base = { phone: event.phone, pollMessageId: open.messageId, at: event.at };
    if (open.choice && open.choice !== label) {
      votes.push({
        kind: 'poll_vote',
        providerId: `${event.providerId}:unvote`,
        ...base,
        optionLabel: open.choice,
        selected: false,
      });
    }
    votes.push({
      kind: 'poll_vote',
      providerId: event.providerId,
      ...base,
      optionLabel: label,
      selected: true,
    });
    open.choice = label;
    return votes;
  }

  private async space(chatId: string): Promise<SpaceLike> {
    const cached = this.spaces.get(chatId);
    if (cached) return cached;
    if (!this.getSpace) throw new Error('transport not started');
    const space = await this.getSpace(chatId);
    this.spaces.set(chatId, space);
    return space;
  }

  private async target(chatId: string, messageId: string): Promise<Message> {
    const known = this.sent.get(messageId);
    if (known) return known;
    const space = await this.space(chatId);
    const found = await space.getMessage(messageId);
    if (!found) throw new Error(`message ${messageId} not found in ${chatId}`);
    return found;
  }

  private remember(message: Message | undefined): string {
    if (!message) return `local_${randomUUID()}`;
    this.sent.set(message.id, message);
    return message.id;
  }

  async send(chatId: string, content: OutContent): Promise<{ messageId: string }> {
    const space = await this.space(chatId);
    const terminal = this.provider === 'terminal';

    switch (content.kind) {
      case 'text': {
        const body = text(content.text);
        if (content.replyToMessageId && !terminal) {
          const target = await this.target(chatId, content.replyToMessageId);
          return { messageId: this.remember(await space.send(reply(body, target))) };
        }
        return { messageId: this.remember(await space.send(body)) };
      }
      case 'poll': {
        if (terminal) {
          const lines = content.options.map((o, i) => `${i + 1}. ${o}`).join('\n');
          const sent = await space.send(`${content.question}\n${lines}\nReply with a number.`);
          const messageId = this.remember(sent);
          this.terminalPolls.set(chatId, { messageId, options: content.options, choice: null });
          return { messageId };
        }
        return {
          messageId: this.remember(await space.send(poll(content.question, ...content.options))),
        };
      }
      case 'link': {
        if (terminal) {
          return { messageId: this.remember(await space.send(`${content.title}\n${content.url}`)) };
        }
        const style = this.options.linkStyle ?? 'text';
        const link =
          style === 'app'
            ? app(content.url)
            : style === 'richlink'
              ? richlink(content.url)
              : text(`🫧 ${content.title}: ${content.url}`);
        return { messageId: this.remember(await space.send(link)) };
      }
      case 'image': {
        if (terminal) {
          return { messageId: this.remember(await space.send(`[image: ${content.name}]`)) };
        }
        return {
          messageId: this.remember(
            await space.send(
              attachment(content.data, { name: content.name, mimeType: content.mimeType }),
            ),
          ),
        };
      }
      case 'mini_app': {
        if (terminal) {
          return {
            messageId: this.remember(
              await space.send(`[card: ${content.caption} — ${content.url}]`),
            ),
          };
        }
        return { messageId: this.remember(await space.send(miniAppContent(content))) };
      }
    }
  }

  async edit(chatId: string, messageId: string, newText: string): Promise<void> {
    const space = await this.space(chatId);
    if (this.provider === 'terminal') {
      await space.send(`(updated) ${newText}`);
      return;
    }
    await space.send(edit(text(newText), await this.target(chatId, messageId)));
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    const space = await this.space(chatId);
    await space.send(reaction(emoji, await this.target(chatId, messageId)));
  }

  async typing(chatId: string, on: boolean): Promise<void> {
    const space = await this.space(chatId);
    await (on ? space.startTyping() : space.stopTyping());
  }

  async stop(): Promise<void> {
    await this.app?.stop();
    await this.loop?.catch(() => undefined);
    this.app = null;
  }
}

/** The spectrum-ts customized mini app content for a card. Exported for tests. */
export function miniAppContent(card: MiniAppCard): ReturnType<typeof customizedMiniApp> {
  const layout: CustomizedMiniAppLayout = { caption: card.caption, summary: card.summary };
  if (card.subcaption) layout.subcaption = card.subcaption;
  if (card.trailingCaption) layout.trailingCaption = card.trailingCaption;
  if (card.trailingSubcaption) layout.trailingSubcaption = card.trailingSubcaption;
  if (card.imageTitle) layout.imageTitle = card.imageTitle;
  if (card.imageSubtitle) layout.imageSubtitle = card.imageSubtitle;
  // The layout schema wants a plain Uint8Array over an ArrayBuffer, not a pooled Buffer view.
  if (card.image?.length) layout.image = new Uint8Array(card.image);
  return customizedMiniApp({
    appName: 'Bubbleworks',
    ...SPECTRUM_EXTENSION,
    url: card.url,
    layout,
    live: false,
  });
}
