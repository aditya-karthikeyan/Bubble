import Database from 'better-sqlite3';
import type {
  InboundGroupMessage,
  InboundPrivateMessage,
  PollVote,
  Reaction,
} from '@bubbleworks/shared';
import { DEMO_GROUP, FakeCrewDirectory, PERSONAS } from '@bubbleworks/shared/fakes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../events/bus.js';
import {
  SpectrumMessaging,
  dmChatId,
  looksLikePlan,
  planIdFromKey,
  renderCard,
  type SpectrumMessagingOptions,
} from './adapter.js';
import { FakeTransport } from './fake-transport.js';
import { MessagingStore } from './store.js';

const [AVA, BEN] = PERSONAS as [(typeof PERSONAS)[0], (typeof PERSONAS)[0]];
const CREW = DEMO_GROUP.chatId;
const at = '2026-10-10T22:00:00.000Z';

async function setup(options: Partial<SpectrumMessagingOptions> = {}) {
  const transport = new FakeTransport('imessage');
  const crews = new FakeCrewDirectory();
  const store = new MessagingStore(new Database(':memory:'));
  const messaging = new SpectrumMessaging({
    transport,
    crews,
    store,
    log: silentLogger,
    debounceMs: 0,
    retry: { attempts: 3, baseDelayMs: 0 },
    ...options,
  });
  await messaging.start();
  const inbox = {
    group: [] as InboundGroupMessage[],
    private: [] as InboundPrivateMessage[],
    votes: [] as PollVote[],
    reactions: [] as Reaction[],
  };
  messaging.onGroupMessage(async (m) => void inbox.group.push(m));
  messaging.onPrivateMessage(async (m) => void inbox.private.push(m));
  messaging.onPollVote(async (v) => void inbox.votes.push(v));
  messaging.onReaction(async (r) => void inbox.reactions.push(r));
  return { transport, crews, store, messaging, inbox };
}

describe('helpers', () => {
  it('reads the plan id off an idempotency key', () => {
    expect(planIdFromKey('plan_1:bundle:poll')).toBe('plan_1');
    expect(planIdFromKey('no-colons')).toBeNull();
  });

  it('renders a live card as text', () => {
    expect(renderCard({ title: 'Dinner', lines: ['4 in'], url: 'https://x/p/t' })).toBe(
      '🫧 Dinner\n4 in\nhttps://x/p/t',
    );
  });

  it('spots plan-shaped messages', () => {
    expect(looksLikePlan('dinner today?')).toBe(true);
    expect(looksLikePlan('anyone hungry')).toBe(true);
    expect(looksLikePlan('I am vegetarian')).toBe(false);
  });
});

describe('outbound', () => {
  it('fans a crew text out to every onboarded member under one logical id', async () => {
    const { transport, messaging } = await setup();
    const result = await messaging.sendGroupText({
      chatId: CREW,
      text: 'Plan starting',
      idempotencyKey: 'plan_1:start',
    });
    expect(result).toEqual({ messageId: 'grp:plan_1:start', deduplicated: false });
    expect(transport.sends().map((s) => s.chatId)).toEqual(
      PERSONAS.map((p) => `any;-;${p.handle}`),
    );
  });

  it('skips members who have not texted their bubble yet', async () => {
    const { transport, crews, messaging } = await setup();
    const dee = await crews.createUser({ displayName: 'Dee', handle: '+15550000009' });
    await crews.addMember(DEMO_GROUP.id, dee.id);
    await messaging.sendGroupText({ chatId: CREW, text: 'x', idempotencyKey: 'plan_1:x' });
    expect(transport.sends().map((s) => s.chatId)).not.toContain('any;-;+15550000009');
    expect(transport.sends()).toHaveLength(PERSONAS.length);
  });

  it('treats a repeated idempotency key as a no-op', async () => {
    const { transport, messaging } = await setup();
    await messaging.sendGroupText({ chatId: CREW, text: 'x', idempotencyKey: 'plan_1:x' });
    const again = await messaging.sendGroupText({
      chatId: CREW,
      text: 'x',
      idempotencyKey: 'plan_1:x',
    });
    expect(again).toEqual({ messageId: 'grp:plan_1:x', deduplicated: true });
    expect(transport.sends()).toHaveLength(PERSONAS.length);
  });

  it('sends a private text to one person and returns the provider id', async () => {
    const { transport, messaging } = await setup();
    const result = await messaging.sendPrivateText({
      userId: AVA.id,
      text: 'private ask',
      idempotencyKey: 'plan_1:ask:1',
    });
    expect(result).toEqual({ messageId: 'spc-msg-1', deduplicated: false });
    expect(transport.sends()).toHaveLength(1);
  });

  it('spends each member plan budget and skips members who are out', async () => {
    const spent = new Map<string, number>();
    const { transport, messaging } = await setup({
      spendMessage: (_planId, userId) => {
        const n = (spent.get(userId) ?? 0) + 1;
        spent.set(userId, n);
        return userId !== BEN.id || n <= 1;
      },
    });
    await messaging.sendGroupText({ chatId: CREW, text: 'a', idempotencyKey: 'plan_1:a' });
    await messaging.sendGroupText({ chatId: CREW, text: 'b', idempotencyKey: 'plan_1:b' });
    const toBen = transport.sends().filter((s) => s.chatId === `any;-;${BEN.handle}`);
    expect(toBen).toHaveLength(1);
    // A replay of an already-sent key spends nothing.
    await messaging.sendGroupText({ chatId: CREW, text: 'a', idempotencyKey: 'plan_1:a' });
    expect(spent.get(AVA.id)).toBe(2);
  });

  it('retries a failed send under the same key, then marks it failed', async () => {
    const { transport, store, messaging } = await setup();
    transport.failNextSends = 2;
    await messaging.sendPrivateText({ userId: AVA.id, text: 'hi', idempotencyKey: 'p:r' });
    expect(store.outbox('p:r')).toMatchObject({ status: 'sent', attempts: 3 });
    transport.failNextSends = 5;
    await expect(
      messaging.sendPrivateText({ userId: AVA.id, text: 'hi', idempotencyKey: 'p:f' }),
    ).rejects.toThrow('transport down');
    expect(store.outbox('p:f')?.status).toBe('failed');
  });

  it('closes a poll by announcing the leading option once', async () => {
    const { transport, messaging } = await setup();
    await messaging.sendPoll({
      chatId: dmChatId(AVA.id),
      planId: 'plan_1',
      pollId: 'poll_1',
      question: 'Cuisine?',
      options: [
        { key: 'thai', label: 'Thai' },
        { key: 'pizza', label: 'Pizza' },
      ],
      idempotencyKey: 'plan_1:poll_1',
    });
    const pollMessageId = transport.sends()[0]!.messageId;
    await messaging.handleInbound({
      kind: 'poll_vote',
      providerId: `${pollMessageId}:a:1`,
      phone: AVA.handle,
      pollMessageId,
      optionLabel: 'Pizza',
      selected: true,
      at,
    });
    await messaging.closePoll({ chatId: dmChatId(AVA.id), pollId: 'poll_1' });
    await messaging.closePoll({ chatId: dmChatId(AVA.id), pollId: 'poll_1' });
    const closing = transport.sends().slice(1);
    expect(closing.map((s) => s.content)).toEqual([{ kind: 'text', text: 'Voting closed: Pizza' }]);
  });

  it('sends the live card once per member and edits every copy afterwards', async () => {
    const { transport, messaging } = await setup();
    const card = (line: string) => ({
      chatId: CREW,
      planId: 'plan_1',
      card: { title: 'Dinner', lines: [line] },
      idempotencyKey: `plan_1:card:${line}`,
    });
    const first = await messaging.upsertLiveCard(card('deciding'));
    await messaging.upsertLiveCard(card('locked'));
    expect(first.messageId).toBe('card:plan_1');
    expect(transport.sends()).toHaveLength(PERSONAS.length);
    expect(transport.calls.filter((c) => c.op === 'edit')).toHaveLength(PERSONAS.length);
  });

  it('edits and reacts on every member copy of a logical message', async () => {
    const { transport, messaging } = await setup();
    const { messageId } = await messaging.sendGroupText({
      chatId: CREW,
      text: 'status',
      idempotencyKey: 'plan_1:status',
    });
    await messaging.editMessage({ chatId: CREW, messageId, text: 'status ✓' });
    expect(transport.calls.filter((c) => c.op === 'edit')).toHaveLength(PERSONAS.length);
  });

  it('threads a crew reply under each member own copy', async () => {
    const { transport, messaging } = await setup();
    const { messageId } = await messaging.sendGroupText({
      chatId: CREW,
      text: 'headcount',
      idempotencyKey: 'plan_1:hc',
    });
    await messaging.replyInThread({
      chatId: CREW,
      text: 'counted',
      replyToMessageId: messageId,
      idempotencyKey: 'plan_1:hc:reply',
    });
    const replies = transport.sends().slice(PERSONAS.length);
    expect(replies.every((s) => s.content.kind === 'text' && s.content.replyToMessageId)).toBe(
      true,
    );
  });

  it('makes rename and background no-ops', async () => {
    const { transport, messaging } = await setup();
    await messaging.renameGroup({ chatId: CREW, name: 'x' });
    await messaging.setBackground({ chatId: CREW, imageUrl: 'https://x' });
    expect(transport.calls).toHaveLength(0);
  });
});

describe('inbound', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('batches a burst and routes a plan-shaped DM to the member crew', async () => {
    const { messaging, inbox } = await setup({ debounceMs: 1500 });
    for (const [i, text] of ['hey', 'dinner today?'].entries()) {
      await messaging.handleInbound({
        kind: 'text',
        providerId: `in_${i}`,
        phone: AVA.handle,
        text,
        at,
      });
      vi.advanceTimersByTime(400);
    }
    expect(inbox.group).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1500);
    expect(inbox.group).toEqual([
      { messageId: 'in_1', chatId: CREW, userId: AVA.id, text: 'hey\ndinner today?', at },
    ]);
    expect(inbox.private).toHaveLength(0);
  });

  it('routes small talk to onPrivateMessage', async () => {
    const { messaging, inbox } = await setup();
    await messaging.handleInbound({
      kind: 'text',
      providerId: 'p1',
      phone: AVA.handle,
      text: 'I am vegetarian',
      at,
    });
    await vi.runAllTimersAsync();
    expect(inbox.private).toEqual([
      { messageId: 'p1', userId: AVA.id, text: 'I am vegetarian', at },
    ]);
  });

  it('routes every DM to the crew while that crew has a plan in flight', async () => {
    const { messaging, inbox } = await setup({ openPlanCrew: async () => DEMO_GROUP.id });
    await messaging.handleInbound({
      kind: 'text',
      providerId: 'p2',
      phone: BEN.handle,
      text: "I'm in",
      at,
    });
    await vi.runAllTimersAsync();
    expect(inbox.group[0]).toMatchObject({ chatId: CREW, userId: BEN.id, text: "I'm in" });
  });

  it('maps a threaded reply on a member copy back to the logical message', async () => {
    const { transport, messaging, inbox } = await setup();
    await messaging.sendGroupText({ chatId: CREW, text: 'headcount', idempotencyKey: 'plan_1:hc' });
    const bensCopy = transport.sends().find((s) => s.chatId === `any;-;${BEN.handle}`)!;
    await messaging.handleInbound({
      kind: 'text',
      providerId: 'r1',
      phone: BEN.handle,
      text: 'in',
      replyToMessageId: bensCopy.messageId,
      at,
    });
    await vi.runAllTimersAsync();
    expect(inbox.group[0]).toMatchObject({ chatId: CREW, replyToMessageId: 'grp:plan_1:hc' });
  });

  it('maps a tapback on a member copy back to the logical message', async () => {
    const { transport, messaging, inbox } = await setup();
    await messaging.sendGroupText({ chatId: CREW, text: 'tap 👍', idempotencyKey: 'plan_1:hc' });
    const bensCopy = transport.sends().find((s) => s.chatId === `any;-;${BEN.handle}`)!;
    await messaging.handleInbound({
      kind: 'reaction',
      providerId: 'rx',
      phone: BEN.handle,
      targetMessageId: bensCopy.messageId,
      emoji: '👍',
      removed: false,
      at,
    });
    expect(inbox.reactions).toEqual([
      { chatId: CREW, messageId: 'grp:plan_1:hc', userId: BEN.id, emoji: '👍', removed: false, at },
    ]);
  });

  it('turns vote deltas into per-voter choices', async () => {
    const { transport, messaging, inbox } = await setup();
    await messaging.sendPoll({
      chatId: CREW,
      planId: 'plan_1',
      pollId: 'poll_cuisine',
      question: 'What are we eating?',
      options: [
        { key: 'thai', label: 'Thai' },
        { key: 'sushi', label: 'Sushi' },
      ],
      idempotencyKey: 'plan_1:poll_cuisine',
    });
    const avasPoll = transport.sends().find((s) => s.chatId === `any;-;${AVA.handle}`)!.messageId;
    const vote = (optionLabel: string, selected: boolean, n: number) =>
      messaging.handleInbound({
        kind: 'poll_vote',
        providerId: `${avasPoll}:${n}`,
        phone: AVA.handle,
        pollMessageId: avasPoll,
        optionLabel,
        selected,
        at,
      });
    await vote('Thai', true, 1);
    await vote('Sushi', true, 2);
    await vote('Thai', false, 3);
    expect(inbox.votes.map((v) => [v.chatId, v.pollId, v.choices])).toEqual([
      [CREW, 'poll_cuisine', ['thai']],
      [CREW, 'poll_cuisine', ['sushi', 'thai']],
      [CREW, 'poll_cuisine', ['sushi']],
    ]);
  });

  it('drops duplicates and unregistered phones, and marks first-time senders onboarded', async () => {
    const { crews, messaging, inbox } = await setup();
    const dee = await crews.createUser({ displayName: 'Dee', handle: '+15550000009' });
    const event = { kind: 'text' as const, providerId: 'd1', phone: dee.handle, text: 'hi', at };
    await messaging.handleInbound(event);
    await messaging.handleInbound(event);
    await messaging.handleInbound({ ...event, providerId: 'd2', phone: '+15559999999' });
    await vi.runAllTimersAsync();
    expect(inbox.private).toHaveLength(1);
    expect((await crews.userById(dee.id))?.onboardedAt).not.toBeNull();
  });
});
