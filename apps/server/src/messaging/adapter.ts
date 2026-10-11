/**
 * SpectrumMessaging: the MessagingPort for crews over DMs (docs/CONTRACTS.md, "Crews over DMs").
 *
 * Chat ids the adapter accepts:
 *   crew:<groupId>   a crew. Sends fan out to every reachable member's DM, one copy each.
 *   dm:<userId>      one person's DM with their bubble (dmChatId()).
 *
 * Outbound: every provider send goes through the p2_outbox under an idempotency key (the
 * caller's key, plus ":<userId>" per crew member), so a repeated key sends nothing. A crew send
 * returns one logical messageId ("grp:<key>"); p2_messages maps each member's copy back to it,
 * so edits, 👍 reactions, and threaded replies line up with the id the engine holds. Crew
 * sends tied to a plan spend the member's plan budget through spendMessage.
 *
 * Inbound: provider events are deduplicated, phones resolve to users through CrewDirectory,
 * texts are batched per sender, poll votes become per-voter choices. A text goes to
 * onGroupMessage when it is plan-related (reply to a crew message, the member's crew has a plan
 * in flight, or it reads like a plan); everything else goes to onPrivateMessage.
 *
 * Crew sends only reach people who have texted their bubble (User.onboardedAt). A private DM also
 * reaches someone who signed up on the website (User.bubbleNumber, set by Photon registration),
 * so their bubble can text them first. The terminal provider reaches everyone. Logs carry ids,
 * kinds, and timings, never message text.
 */
import {
  groupIdFromChatId,
  type CrewDirectory,
  type GroupTextInput,
  type InboundGroupMessage,
  type InboundPrivateMessage,
  type LiveCard,
  type LiveCardInput,
  type MemberChange,
  type MessagingPort,
  type PollInput,
  type PollVote,
  type PrivateTextInput,
  type Reaction,
  type RichLinkInput,
  type SendResult,
  type Unsubscribe,
  type Presence,
  type User,
} from '@bubbleworks/shared';
import type { Logger } from '../events/bus.js';
import { Batcher, mergeBatch, type Batch } from './batcher.js';
import type { RawInbound } from './normalize.js';
import type { MessagingStore } from './store.js';
import type { MiniAppCard, OutContent, Transport } from './transport.js';

export interface SpectrumMessagingOptions {
  transport: Transport;
  crews: CrewDirectory;
  store: MessagingStore;
  log: Logger;
  /** Landing page. A text from a phone we do not know gets this link (once per 10 minutes). */
  signupUrl?: string | null;
  debounceMs: number;
  /** Spends one crew message from the member's plan budget. False when the budget is spent. */
  spendMessage?: (planId: string, userId: string) => boolean;
  /** The crew whose plan is in flight for this member, so their DMs route to that plan. */
  openPlanCrew?: (userId: string) => Promise<string | null>;
  /** Send "Voting closed: X" when a poll closes. Default true; the server turns it off. */
  announcePollClose?: boolean;
  retry?: { attempts: number; baseDelayMs: number };
}

const DM_PREFIX = 'dm:';
/** Someone who texted within this window is treated as awake, whatever their presence says. */
export const QUIET_OVERRIDE_MS = 15 * 60_000;

export function dmChatId(userId: string): string {
  return `${DM_PREFIX}${userId}`;
}

export function userIdFromDmChatId(chatId: string): string | null {
  return chatId.startsWith(DM_PREFIX) ? chatId.slice(DM_PREFIX.length) : null;
}

/** Keys come from idempotencyKey(planId, action, ...), so the plan id is the first segment. */
export function planIdFromKey(key: string): string | null {
  const [head] = key.split(':');
  return head && head !== key ? head : null;
}

/** First-pass plan detector for routing. P2 Phase 2 replaces it with keywords + Haiku. */
const PLAN_WORDS =
  /\b(dinner|lunch|brunch|breakfast|eat|eating|food|hungry|grab|tonight|drinks|coffee|plans?)\b/i;
export function looksLikePlan(text: string): boolean {
  return PLAN_WORDS.test(text);
}

export function renderCard(card: LiveCard): string {
  return [`🫧 ${card.title}`, ...card.lines, ...(card.url ? [card.url] : [])].join('\n');
}

type Handlers = {
  group: Array<(m: InboundGroupMessage) => Promise<void>>;
  private: Array<(m: InboundPrivateMessage) => Promise<void>>;
  vote: Array<(v: PollVote) => Promise<void>>;
  reaction: Array<(r: Reaction) => Promise<void>>;
  member: Array<(c: MemberChange) => Promise<void>>;
  location: Array<(l: InboundLocation) => Promise<void>>;
};

/** A one-time location pin someone sent their bubble (+ -> Location -> Share). */
export interface InboundLocation {
  userId: string;
  messageId: string;
  lat: number;
  lng: number;
  at: string;
}

interface FanOptions {
  chatId: string;
  key: string;
  planId: string | null;
  content: (userId: string) => OutContent;
  afterSend?: (userId: string, providerMessageId: string, deduplicated: boolean) => void;
}

export class SpectrumMessaging implements MessagingPort {
  private readonly handlers: Handlers = {
    group: [],
    private: [],
    vote: [],
    reaction: [],
    member: [],
    location: [],
  };
  private gate:
    | ((m: { userId: string; messageId: string; text: string; at: string }) => Promise<boolean>)
    | null = null;
  private presence: ((userId: string) => Promise<Presence>) | null = null;
  private readonly pollClosed: Array<(pollId: string) => Promise<unknown>> = [];
  /** Last time each person texted their bubble, for the quiet-hours override. */
  private readonly lastInbound = new Map<string, number>();
  private readonly signupNudged = new Map<string, number>();
  private pendingAnswer: ((userId: string) => string | null) | null = null;

  /**
   * The intake's open plan question ("Which crew, and what are we feeling?"): while one waits on
   * this person, their next text is the answer and routes to the crew chat this returns.
   */
  setPendingAnswer(fn: (userId: string) => string | null): void {
    this.pendingAnswer = fn;
  }

  /**
   * Hands a message the plan intake routed to itself but did not act on (not a plan after all,
   * "new crew <name>" mid-question) to the private handlers, so the bubble answers it.
   */
  async deliverPrivate(m: InboundPrivateMessage): Promise<void> {
    await this.emit(this.handlers.private, m);
  }
  /** Provider id -> the batch messageId it was delivered under, so an edit can name it. */
  private readonly deliveredAs = new Map<string, string>();
  private readonly rawText: Array<(userId: string, text: string, at: string) => boolean | void> =
    [];
  private readonly batcher: Batcher;
  private readonly retry: { attempts: number; baseDelayMs: number };

  constructor(private readonly o: SpectrumMessagingOptions) {
    this.batcher = new Batcher(o.debounceMs, (batch) => this.flushBatch(batch));
    this.retry = o.retry ?? { attempts: 3, baseDelayMs: 500 };
  }

  async start(): Promise<void> {
    await this.o.transport.start((event) => {
      void this.handleInbound(event).catch((err: unknown) =>
        this.o.log.error({ err: String(err), kind: event.kind }, 'inbound handler failed'),
      );
    });
    this.o.log.info({ provider: this.o.transport.provider }, 'messaging started');
  }

  async stop(): Promise<void> {
    await this.batcher.drain();
    await this.o.transport.stop();
  }

  // -- outbound --------------------------------------------------------------

  sendGroupText(input: GroupTextInput): Promise<SendResult> {
    return this.fan({
      chatId: input.chatId,
      key: input.idempotencyKey,
      planId: planIdFromKey(input.idempotencyKey),
      content: (userId) => this.textFor(userId, input.text, input.replyToMessageId),
    });
  }

  sendPrivateText(input: PrivateTextInput): Promise<SendResult> {
    return this.fan({
      chatId: dmChatId(input.userId),
      key: input.idempotencyKey,
      planId: null,
      content: () => ({ kind: 'text', text: input.text }),
    });
  }

  replyInThread(input: GroupTextInput & { replyToMessageId: string }): Promise<SendResult> {
    return this.sendGroupText(input);
  }

  sendPoll(input: PollInput): Promise<SendResult> {
    this.o.store.savePoll({ pollId: input.pollId, chatId: input.chatId, options: input.options });
    return this.fan({
      chatId: input.chatId,
      key: input.idempotencyKey,
      planId: input.planId,
      content: () => ({
        kind: 'poll',
        question: input.question,
        options: input.options.map((o) => o.label),
      }),
      afterSend: (userId, providerMessageId) =>
        this.o.store.savePollMessage(providerMessageId, input.pollId, userId),
    });
  }

  /** iMessage polls cannot be closed or edited, so closing announces the leader instead. */
  async closePoll(input: { chatId: string; pollId: string }): Promise<void> {
    const poll = this.o.store.poll(input.pollId);
    if (!poll || !this.o.store.closePoll(input.pollId)) return;
    for (const handler of this.pollClosed) {
      await handler(input.pollId).catch((err: unknown) =>
        this.o.log.error({ err: String(err), pollId: input.pollId }, 'poll-closed handler failed'),
      );
    }
    // The live card already moves on ("finding the spot"); skipping this saves a ping each.
    if (this.o.announcePollClose === false) return;
    const tally = this.o.store.tally(input.pollId);
    const leader = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    const label = leader && poll.options.find((o) => o.key === leader[0])?.label;
    await this.fan({
      chatId: input.chatId,
      key: `${input.pollId}:closed`,
      planId: null,
      content: () => ({ kind: 'text', text: label ? `Voting closed: ${label}` : 'Voting closed.' }),
    });
  }

  /** Image to every member of a crew (or one dm: chat). Not part of MessagingPort. */
  sendImage(input: {
    chatId: string;
    data: Buffer;
    name: string;
    mimeType: string;
    idempotencyKey: string;
  }): Promise<SendResult> {
    return this.fan({
      chatId: input.chatId,
      key: input.idempotencyKey,
      planId: planIdFromKey(input.idempotencyKey),
      content: () => ({
        kind: 'image',
        data: input.data,
        name: input.name,
        mimeType: input.mimeType,
      }),
    });
  }

  /** Native iMessage Mini App card to every member of a crew (or one dm: chat). Not part of MessagingPort. */
  sendMiniApp(
    input: MiniAppCard & { chatId: string; idempotencyKey: string },
  ): Promise<SendResult> {
    const { chatId, idempotencyKey: key, ...card } = input;
    return this.fan({
      chatId,
      key,
      planId: planIdFromKey(key),
      content: () => ({ kind: 'mini_app', ...card }),
    });
  }

  sendRichLink(input: RichLinkInput): Promise<SendResult> {
    return this.fan({
      chatId: input.chatId,
      key: input.idempotencyKey,
      planId: planIdFromKey(input.idempotencyKey),
      content: () => ({ kind: 'link', url: input.url, title: input.title }),
    });
  }

  /** One card per member per plan: sent once, edited in place afterwards. */
  async upsertLiveCard(input: LiveCardInput): Promise<SendResult> {
    const text = renderCard(input.card);
    const logicalId = `card:${input.planId}`;
    const members = await this.recipients(input.chatId);
    await Promise.all(
      members.map(async (user) => {
        const existing = this.o.store.liveCard(input.planId, user.id);
        if (existing) {
          await this.o.transport.edit(this.providerChat(user), existing, text);
          return;
        }
        if (this.o.spendMessage && !this.o.spendMessage(input.planId, user.id)) return;
        const sent = await this.deliver(`${input.idempotencyKey}:${user.id}`, user, {
          kind: 'text',
          text,
        });
        this.o.store.setLiveCard(input.planId, user.id, sent.messageId);
        this.o.store.recordCopy({
          providerMessageId: sent.messageId,
          logicalId,
          chatId: input.chatId,
          userId: user.id,
        });
      }),
    );
    return { messageId: logicalId, deduplicated: false };
  }

  async editMessage(input: { chatId: string; messageId: string; text: string }): Promise<void> {
    await this.forEachCopy(input.messageId, (user, providerId) =>
      this.o.transport.edit(this.providerChat(user), providerId, input.text),
    );
  }

  async react(input: {
    chatId: string;
    messageId: string;
    emoji: string;
    remove?: boolean;
  }): Promise<void> {
    if (input.remove) return; // spectrum-ts does not expose tapback removal.
    await this.forEachCopy(input.messageId, (user, providerId) =>
      this.o.transport.react(this.providerChat(user), providerId, input.emoji),
    );
  }

  /** Fire and forget: the typing bubble must not wait on the network round trip. */
  async setTyping(input: { chatId: string; typing: boolean }): Promise<void> {
    const members = await this.recipients(input.chatId);
    for (const user of members) {
      void this.o.transport
        .typing(this.providerChat(user), input.typing)
        .catch((err: unknown) =>
          this.o.log.warn({ err: String(err), userId: user.id }, 'typing failed'),
        );
    }
  }

  async renameGroup(input: { chatId: string; name: string }): Promise<void> {
    this.o.log.debug({ chatId: input.chatId }, 'renameGroup is a no-op for crews');
  }

  async setBackground(input: { chatId: string; imageUrl: string }): Promise<void> {
    this.o.log.debug({ chatId: input.chatId }, 'setBackground is a no-op for crews');
  }

  // -- inbound registration --------------------------------------------------

  onGroupMessage(handler: (m: InboundGroupMessage) => Promise<void>): Unsubscribe {
    return add(this.handlers.group, handler);
  }
  onPrivateMessage(handler: (m: InboundPrivateMessage) => Promise<void>): Unsubscribe {
    return add(this.handlers.private, handler);
  }
  onPollVote(handler: (v: PollVote) => Promise<void>): Unsubscribe {
    return add(this.handlers.vote, handler);
  }
  onReaction(handler: (r: Reaction) => Promise<void>): Unsubscribe {
    return add(this.handlers.reaction, handler);
  }
  /**
   * Called for every inbound text before batching, so detection can show the typing bubble
   * within a second instead of after the debounce window. Returning true delivers the
   * sender's batch now instead of waiting out the window. Not part of MessagingPort.
   */
  onTextReceived(
    handler: (userId: string, text: string, at: string) => boolean | void,
  ): Unsubscribe {
    return add(this.rawText, handler);
  }

  /** Location pins people send their bubble. Not part of MessagingPort (P3 stores them). */
  onLocation(handler: (l: InboundLocation) => Promise<void>): Unsubscribe {
    return add(this.handlers.location, handler);
  }

  /** Crew membership changes come from P3's declaration flow, so this never fires. */
  onMemberChange(handler: (c: MemberChange) => Promise<void>): Unsubscribe {
    return add(this.handlers.member, handler);
  }

  // -- inbound ---------------------------------------------------------------

  /** Public for tests and the sim: the transport calls this for every provider event. */
  async handleInbound(event: RawInbound): Promise<void> {
    if (!this.o.store.markSeen(event.providerId)) return;
    const user = await this.o.crews.userByHandle(event.phone);
    if (!user) {
      this.o.log.warn({ kind: event.kind }, 'inbound from an unregistered phone dropped');
      if (event.kind === 'text') await this.inviteToSignUp(event.phone);
      return;
    }
    this.lastInbound.set(user.id, Date.now());
    if (!user.onboardedAt) {
      await this.o.crews.updateUser(user.id, { onboardedAt: new Date().toISOString() });
      this.o.log.info({ userId: user.id }, 'first message from member: onboarded');
    }

    switch (event.kind) {
      case 'location': {
        // P3's contract (#41): the pin reaches the bubble as a private message with `location`
        // set and empty text. onLocation stays for anything else that wants pins.
        const pin: InboundPrivateMessage & { location: { lat: number; lng: number } } = {
          messageId: event.providerId,
          userId: user.id,
          text: '',
          at: event.at,
          location: { lat: event.lat, lng: event.lng },
        };
        await this.emit(this.handlers.private, pin);
        await this.emit(this.handlers.location, {
          userId: user.id,
          messageId: event.providerId,
          lat: event.lat,
          lng: event.lng,
          at: event.at,
        });
        return;
      }
      case 'text': {
        let flushNow = false;
        for (const handler of this.rawText) {
          try {
            if (handler(user.id, event.text, event.at) === true) flushNow = true;
          } catch (err) {
            this.o.log.error({ err: String(err) }, 'raw text handler threw');
          }
        }
        this.batcher.add(user.id, {
          providerId: event.providerId,
          text: event.text,
          at: event.at,
          ...(event.replyToMessageId ? { replyToMessageId: event.replyToMessageId } : {}),
        });
        if (flushNow) this.batcher.flushNow(user.id);
        return;
      }
      case 'edit': {
        // Straight to the bubble (P3 re-reads onboarding answers); no batching, no plan routing.
        const edit: InboundPrivateMessage = {
          messageId: event.providerId,
          editOf: this.deliveredAs.get(event.editOf) ?? event.editOf,
          userId: user.id,
          text: event.text,
          at: event.at,
        };
        if (this.gate) {
          const handled = await this.gate(edit).catch(() => false);
          if (handled) return;
        }
        await this.emit(this.handlers.private, edit);
        return;
      }
      case 'reaction': {
        const copy = this.o.store.copy(event.targetMessageId);
        await this.emit(this.handlers.reaction, {
          chatId: copy?.chatId ?? dmChatId(user.id),
          messageId: copy?.logicalId ?? event.targetMessageId,
          userId: user.id,
          emoji: event.emoji,
          removed: event.removed,
          at: event.at,
        });
        return;
      }
      case 'poll_vote': {
        const pollId =
          this.o.store.pollIdForMessage(event.pollMessageId) ??
          this.o.store.latestPollIdFor(user.id);
        const poll = pollId ? this.o.store.poll(pollId) : null;
        const option = poll?.options.find((o) => o.label === event.optionLabel);
        if (!poll || !option) {
          this.o.log.warn({ userId: user.id }, 'vote for an unknown poll dropped');
          return;
        }
        const choices = this.o.store.applyVote(poll.pollId, user.id, option.key, event.selected);
        await this.emit(this.handlers.vote, {
          chatId: poll.chatId,
          pollId: poll.pollId,
          userId: user.id,
          choices,
          at: event.at,
        });
        return;
      }
    }
  }

  /**
   * Runs on every inbound batch before routing. Returning true means the gate handled the message
   * (e.g. refused a probe about someone else) and nobody else sees it. Not part of MessagingPort.
   */
  setInboundGate(
    gate: (m: { userId: string; messageId: string; text: string; at: string }) => Promise<boolean>,
  ): void {
    this.gate = gate;
  }

  /** Runs after a poll closes (e.g. send the next question). Not part of MessagingPort. */
  onPollClosed(handler: (pollId: string) => Promise<unknown>): Unsubscribe {
    return add(this.pollClosed, handler);
  }

  /** Presence source for quiet hours (P3's BubbleService.getPresence). Not part of MessagingPort. */
  setPresence(presence: (userId: string) => Promise<Presence>): void {
    this.presence = presence;
  }

  private async flushBatch(batch: Batch): Promise<void> {
    const userId = batch.key;
    const merged = mergeBatch(batch.items);
    for (const item of batch.items) this.deliveredAs.set(item.providerId, merged.messageId);
    if (this.deliveredAs.size > 5_000) {
      for (const key of [...this.deliveredAs.keys()].slice(0, 1_000)) this.deliveredAs.delete(key);
    }
    if (this.gate) {
      const handled = await this.gate({
        userId,
        messageId: merged.messageId,
        text: merged.text,
        at: merged.at,
      }).catch((err: unknown) => {
        this.o.log.error({ err: String(err), userId }, 'inbound gate failed; passing message on');
        return false;
      });
      if (handled) return;
    }
    const replied = merged.replyToMessageId ? this.o.store.copy(merged.replyToMessageId) : null;
    const crewChat =
      replied && groupIdFromChatId(replied.chatId)
        ? replied.chatId
        : await this.planCrewChat(userId, merged.text);

    this.o.log.debug(
      { userId, parts: batch.items.length, route: crewChat ? 'group' : 'private' },
      'inbound batch',
    );
    if (crewChat) {
      await this.emit(this.handlers.group, {
        messageId: merged.messageId,
        chatId: crewChat,
        userId,
        text: merged.text,
        at: merged.at,
        ...(replied ? { replyToMessageId: replied.logicalId } : {}),
      });
      return;
    }
    await this.emit(this.handlers.private, {
      messageId: merged.messageId,
      userId,
      text: merged.text,
      at: merged.at,
    });
  }

  /**
   * The crew a DM belongs to: the one an open plan question is waiting on, the one with a plan in
   * flight, or any active crew if it reads like a plan.
   */
  private async planCrewChat(userId: string, text: string): Promise<string | null> {
    const answering = this.pendingAnswer?.(userId);
    if (answering) return answering;
    const open = await this.o.openPlanCrew?.(userId);
    if (open) return `crew:${open}`;
    if (!looksLikePlan(text)) return null;
    const crews = await this.o.crews.crewsOf(userId);
    return crews.find((c) => c.status === 'active')?.chatId ?? null;
  }

  private async emit<T>(handlers: Array<(v: T) => Promise<void>>, value: T): Promise<void> {
    for (const handler of handlers) {
      try {
        await handler(value);
      } catch (err) {
        this.o.log.error({ err: String(err) }, 'messaging handler threw');
      }
    }
  }

  // -- internals -------------------------------------------------------------

  /** Reachable people behind a chat id: crew members, or the one DM owner. */
  private async recipients(chatId: string): Promise<User[]> {
    const groupId = groupIdFromChatId(chatId);
    const dmUser = userIdFromDmChatId(chatId);
    let users: User[];
    if (groupId) users = await this.o.crews.membersOf(groupId);
    else if (dmUser) {
      const user = await this.o.crews.userById(dmUser);
      users = user ? [user] : [];
    } else throw new Error(`unknown chat id ${chatId}`);
    const out: User[] = [];
    for (const user of users) {
      if (!this.reachable(user, dmUser !== null)) continue;
      if (await this.isQuiet(user)) {
        this.o.log.info({ userId: user.id, chatId }, 'quiet hours: message held');
        continue;
      }
      out.push(user);
    }
    return out;
  }

  /**
   * Someone who texted their bubble is reachable everywhere. Someone who only signed up (Photon
   * registered them and gave them a bubble number) is reachable in their own DM, so the bubble
   * can text first; crew fan-out still waits for their first reply.
   */
  private reachable(user: User, dm: boolean): boolean {
    if (this.o.transport.provider === 'terminal' || user.onboardedAt !== null) return true;
    return dm && user.bubbleNumber !== null;
  }

  /**
   * Quiet hours: nobody asleep or driving gets pinged. Someone who texted in the last 15 minutes
   * is clearly awake and not driving, whatever their Focus says.
   */
  private async isQuiet(user: User): Promise<boolean> {
    if (!this.presence) return false;
    const last = this.lastInbound.get(user.id);
    if (last !== undefined && Date.now() - last < QUIET_OVERRIDE_MS) return false;
    const presence = await this.presence(user.id).catch(() => 'unknown' as const);
    return presence === 'sleep' || presence === 'driving';
  }

  /** Terminal chats are named after the phone; iMessage DMs are "any;-;<phone>". */
  /** Someone we do not know (or someone who said "forget me") texted: point them at signup. */
  private async inviteToSignUp(phone: string): Promise<void> {
    const url = this.o.signupUrl;
    if (!url) return;
    const now = Date.now();
    if (now - (this.signupNudged.get(phone) ?? 0) < 10 * 60_000) return;
    this.signupNudged.set(phone, now);
    const chat = this.o.transport.provider === 'terminal' ? phone : `any;-;${phone}`;
    try {
      await this.o.transport.send(chat, {
        kind: 'text',
        text: `I don't have you yet 🫧 Sign up here and I'll be your bubble: ${url}`,
      });
      this.o.log.info({}, 'signup nudge sent to an unregistered phone');
    } catch (err) {
      this.o.log.warn({ err: (err as Error).message }, 'signup nudge failed');
    }
  }

  private providerChat(user: User): string {
    return this.o.transport.provider === 'terminal' ? user.handle : `any;-;${user.handle}`;
  }

  /** Text for one member, threaded under that member's copy of the logical message. */
  private textFor(userId: string, text: string, replyToLogicalId?: string): OutContent {
    if (!replyToLogicalId) return { kind: 'text', text };
    const copy =
      this.o.store.copiesOf(replyToLogicalId).find((c) => c.userId === userId) ??
      this.o.store.copy(replyToLogicalId);
    return copy && copy.userId === userId
      ? { kind: 'text', text, replyToMessageId: copy.providerMessageId }
      : { kind: 'text', text };
  }

  private async fan(options: FanOptions): Promise<SendResult> {
    const crew = groupIdFromChatId(options.chatId) !== null;
    const logicalId = crew ? `grp:${options.key}` : null;
    const members = await this.recipients(options.chatId);
    const results = await Promise.all(
      members.map(async (user) => {
        const key = crew ? `${options.key}:${user.id}` : options.key;
        const prior = this.o.store.outbox(key);
        if (
          crew &&
          options.planId &&
          prior?.status !== 'sent' &&
          this.o.spendMessage &&
          !this.o.spendMessage(options.planId, user.id)
        ) {
          this.o.log.warn({ planId: options.planId, userId: user.id }, 'message budget spent');
          return null;
        }
        let sent: SendResult;
        try {
          sent = await this.deliver(key, user, options.content(user.id));
        } catch (err) {
          // One member's failure (e.g. Photon's allowlist) must not cost everyone else the message.
          if (!crew) throw err;
          this.o.log.error({ key, userId: user.id, err: String(err) }, 'crew member send failed');
          return null;
        }
        this.o.store.recordCopy({
          providerMessageId: sent.messageId,
          logicalId: logicalId ?? sent.messageId,
          chatId: options.chatId,
          userId: user.id,
        });
        options.afterSend?.(user.id, sent.messageId, sent.deduplicated);
        return sent;
      }),
    );
    const sent = results.filter((r): r is SendResult => r !== null);
    const deduplicated = sent.length > 0 && sent.every((r) => r.deduplicated);
    if (logicalId) return { messageId: logicalId, deduplicated };
    const only = sent[0];
    if (!only && members.length === 0) {
      // Quiet hours or not onboarded: hold the private message instead of failing the caller.
      return { messageId: `held:${options.key}`, deduplicated: false };
    }
    if (!only) throw new Error(`nobody reachable in ${options.chatId}`);
    return only;
  }

  private async deliver(key: string, user: User, content: OutContent): Promise<SendResult> {
    const prior = this.o.store.outbox(key);
    if (prior?.status === 'sent' && prior.providerMessageId) {
      return { messageId: prior.providerMessageId, deduplicated: true };
    }
    this.o.store.begin(key, user.id);
    const chat = this.providerChat(user);

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      this.o.store.attempt(key);
      const started = performance.now();
      try {
        const { messageId } = await this.o.transport.send(chat, content);
        this.o.store.sent(key, messageId);
        this.o.log.info(
          { key, userId: user.id, kind: content.kind, ms: Math.round(performance.now() - started) },
          'message sent',
        );
        return { messageId, deduplicated: false };
      } catch (err) {
        lastError = err;
        this.o.log.warn({ key, attempt, err: String(err) }, 'send failed');
        if (attempt < this.retry.attempts) {
          await sleep(this.retry.baseDelayMs * 4 ** (attempt - 1));
        }
      }
    }
    this.o.store.failed(key, String(lastError));
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Runs fn on every member copy of a logical message, or on the provider message itself. */
  private async forEachCopy(
    messageId: string,
    fn: (user: User, providerMessageId: string) => Promise<void>,
  ): Promise<void> {
    const copies = this.o.store.copiesOf(messageId);
    const targets = copies.length ? copies : [this.o.store.copy(messageId)].filter((c) => c);
    await Promise.all(
      targets.map(async (copy) => {
        if (!copy) return;
        const user = await this.o.crews.userById(copy.userId);
        if (user) await fn(user, copy.providerMessageId);
      }),
    );
  }
}

function add<T>(list: T[], handler: T): Unsubscribe {
  list.push(handler);
  return () => {
    const i = list.indexOf(handler);
    if (i >= 0) list.splice(i, 1);
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
