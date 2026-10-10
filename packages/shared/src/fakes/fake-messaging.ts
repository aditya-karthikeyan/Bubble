/**
 * FakeMessaging: prints every outbound call and records it. Inbound handlers are registered
 * like the real adapter; tests drive them through the simulate* helpers.
 */
import type {
  GroupTextInput,
  InboundGroupMessage,
  InboundPrivateMessage,
  LiveCardInput,
  MemberChange,
  MessagingPort,
  PollInput,
  PollVote,
  PrivateTextInput,
  Reaction,
  RichLinkInput,
  SendResult,
  Unsubscribe,
} from '../ports.js';

export type RecordedSend =
  | { kind: 'group_text'; input: GroupTextInput; messageId: string }
  | { kind: 'private_text'; input: PrivateTextInput; messageId: string }
  | { kind: 'poll'; input: PollInput; messageId: string }
  | { kind: 'close_poll'; chatId: string; pollId: string }
  | { kind: 'rich_link'; input: RichLinkInput; messageId: string }
  | { kind: 'edit'; chatId: string; messageId: string; text: string }
  | { kind: 'react'; chatId: string; messageId: string; emoji: string; remove: boolean }
  | { kind: 'thread_reply'; input: GroupTextInput; messageId: string }
  | { kind: 'typing'; chatId: string; typing: boolean }
  | { kind: 'rename'; chatId: string; name: string }
  | { kind: 'background'; chatId: string; imageUrl: string }
  | { kind: 'live_card'; input: LiveCardInput; messageId: string };

type Handlers = {
  group: Array<(m: InboundGroupMessage) => Promise<void>>;
  private: Array<(m: InboundPrivateMessage) => Promise<void>>;
  vote: Array<(v: PollVote) => Promise<void>>;
  reaction: Array<(r: Reaction) => Promise<void>>;
  member: Array<(c: MemberChange) => Promise<void>>;
};

export interface FakeMessagingOptions {
  /** Print each send to stdout. Default true outside tests. */
  print?: boolean;
  log?: (line: string) => void;
}

export class FakeMessaging implements MessagingPort {
  readonly sent: RecordedSend[] = [];
  private readonly seenKeys = new Map<string, SendResult>();
  private readonly liveCards = new Map<string, string>();
  private readonly handlers: Handlers = {
    group: [],
    private: [],
    vote: [],
    reaction: [],
    member: [],
  };
  private counter = 0;
  private readonly print: boolean;
  private readonly log: (line: string) => void;

  constructor(options: FakeMessagingOptions = {}) {
    this.print = options.print ?? process.env['NODE_ENV'] !== 'test';
    this.log = options.log ?? ((line) => console.log(line));
  }

  // -- outbound ------------------------------------------------------------

  async sendGroupText(input: GroupTextInput): Promise<SendResult> {
    return this.dedupe(input.idempotencyKey, () => {
      const messageId = this.nextId('msg');
      this.record(
        { kind: 'group_text', input, messageId },
        `[group ${input.chatId}] ${input.text}`,
      );
      return messageId;
    });
  }

  async sendPrivateText(input: PrivateTextInput): Promise<SendResult> {
    return this.dedupe(input.idempotencyKey, () => {
      const messageId = this.nextId('msg');
      this.record({ kind: 'private_text', input, messageId }, `[dm ${input.userId}] ${input.text}`);
      return messageId;
    });
  }

  async sendPoll(input: PollInput): Promise<SendResult> {
    return this.dedupe(input.idempotencyKey, () => {
      const messageId = this.nextId('poll');
      const opts = input.options.map((o) => o.label).join(' | ');
      this.record(
        { kind: 'poll', input, messageId },
        `[poll ${input.chatId}] ${input.question} (${opts})`,
      );
      return messageId;
    });
  }

  async closePoll(input: { chatId: string; pollId: string }): Promise<void> {
    this.record({ kind: 'close_poll', ...input }, `[poll ${input.chatId}] closed ${input.pollId}`);
  }

  async sendRichLink(input: RichLinkInput): Promise<SendResult> {
    return this.dedupe(input.idempotencyKey, () => {
      const messageId = this.nextId('link');
      this.record(
        { kind: 'rich_link', input, messageId },
        `[link ${input.chatId}] ${input.title} ${input.url}`,
      );
      return messageId;
    });
  }

  async editMessage(input: { chatId: string; messageId: string; text: string }): Promise<void> {
    this.record({ kind: 'edit', ...input }, `[edit ${input.messageId}] ${input.text}`);
  }

  async react(input: {
    chatId: string;
    messageId: string;
    emoji: string;
    remove?: boolean;
  }): Promise<void> {
    const remove = input.remove ?? false;
    this.record(
      {
        kind: 'react',
        chatId: input.chatId,
        messageId: input.messageId,
        emoji: input.emoji,
        remove,
      },
      `[react ${input.messageId}] ${remove ? '-' : '+'}${input.emoji}`,
    );
  }

  async replyInThread(input: GroupTextInput & { replyToMessageId: string }): Promise<SendResult> {
    return this.dedupe(input.idempotencyKey, () => {
      const messageId = this.nextId('msg');
      this.record(
        { kind: 'thread_reply', input, messageId },
        `[thread ${input.replyToMessageId}] ${input.text}`,
      );
      return messageId;
    });
  }

  async setTyping(input: { chatId: string; typing: boolean }): Promise<void> {
    this.record(
      { kind: 'typing', ...input },
      `[typing ${input.chatId}] ${input.typing ? 'on' : 'off'}`,
    );
  }

  async renameGroup(input: { chatId: string; name: string }): Promise<void> {
    this.record({ kind: 'rename', ...input }, `[rename ${input.chatId}] ${input.name}`);
  }

  async setBackground(input: { chatId: string; imageUrl: string }): Promise<void> {
    this.record({ kind: 'background', ...input }, `[background ${input.chatId}] ${input.imageUrl}`);
  }

  async upsertLiveCard(input: LiveCardInput): Promise<SendResult> {
    return this.dedupe(input.idempotencyKey, () => {
      const existing = this.liveCards.get(input.planId);
      const messageId = existing ?? this.nextId('card');
      this.liveCards.set(input.planId, messageId);
      this.record(
        { kind: 'live_card', input, messageId },
        `[card ${input.chatId}] ${input.card.title}: ${input.card.lines.join(' / ')}`,
      );
      return messageId;
    });
  }

  // -- inbound registration ------------------------------------------------

  onGroupMessage(handler: (m: InboundGroupMessage) => Promise<void>): Unsubscribe {
    return this.add(this.handlers.group, handler);
  }
  onPrivateMessage(handler: (m: InboundPrivateMessage) => Promise<void>): Unsubscribe {
    return this.add(this.handlers.private, handler);
  }
  onPollVote(handler: (v: PollVote) => Promise<void>): Unsubscribe {
    return this.add(this.handlers.vote, handler);
  }
  onReaction(handler: (r: Reaction) => Promise<void>): Unsubscribe {
    return this.add(this.handlers.reaction, handler);
  }
  onMemberChange(handler: (c: MemberChange) => Promise<void>): Unsubscribe {
    return this.add(this.handlers.member, handler);
  }

  // -- test drivers --------------------------------------------------------

  async simulateGroupMessage(
    m: Omit<InboundGroupMessage, 'messageId' | 'at'> & Partial<InboundGroupMessage>,
  ) {
    const full: InboundGroupMessage = {
      messageId: this.nextId('in'),
      at: new Date().toISOString(),
      ...m,
    };
    await Promise.all(this.handlers.group.map((h) => h(full)));
    return full;
  }

  async simulatePrivateMessage(
    m: Omit<InboundPrivateMessage, 'messageId' | 'at'> & Partial<InboundPrivateMessage>,
  ) {
    const full: InboundPrivateMessage = {
      messageId: this.nextId('in'),
      at: new Date().toISOString(),
      ...m,
    };
    await Promise.all(this.handlers.private.map((h) => h(full)));
    return full;
  }

  async simulatePollVote(v: Omit<PollVote, 'at'> & Partial<PollVote>) {
    const full: PollVote = { at: new Date().toISOString(), ...v };
    await Promise.all(this.handlers.vote.map((h) => h(full)));
    return full;
  }

  async simulateReaction(r: Omit<Reaction, 'at' | 'removed'> & Partial<Reaction>) {
    const full: Reaction = { at: new Date().toISOString(), removed: false, ...r };
    await Promise.all(this.handlers.reaction.map((h) => h(full)));
    return full;
  }

  async simulateMemberChange(c: Omit<MemberChange, 'at'> & Partial<MemberChange>) {
    const full: MemberChange = { at: new Date().toISOString(), ...c };
    await Promise.all(this.handlers.member.map((h) => h(full)));
    return full;
  }

  /** Recorded sends of one kind, for assertions. */
  ofKind<K extends RecordedSend['kind']>(kind: K): Array<Extract<RecordedSend, { kind: K }>> {
    return this.sent.filter((s): s is Extract<RecordedSend, { kind: K }> => s.kind === kind);
  }

  reset(): void {
    this.sent.length = 0;
    this.seenKeys.clear();
    this.liveCards.clear();
  }

  // -- internals -----------------------------------------------------------

  private add<T>(list: T[], handler: T): Unsubscribe {
    list.push(handler);
    return () => {
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    };
  }

  private dedupe(key: string, send: () => string): SendResult {
    const seen = this.seenKeys.get(key);
    if (seen) return { ...seen, deduplicated: true };
    const result: SendResult = { messageId: send(), deduplicated: false };
    this.seenKeys.set(key, result);
    return result;
  }

  private record(entry: RecordedSend, line: string): void {
    this.sent.push(entry);
    if (this.print) this.log(`FakeMessaging ${line}`);
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }
}
