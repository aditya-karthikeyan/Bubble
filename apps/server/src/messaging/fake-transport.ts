/**
 * In-memory Transport for unit tests: records every call and lets a test push inbound events.
 */
import type { RawInbound } from './normalize.js';
import type { OutContent, Transport } from './transport.js';

export type TransportCall =
  | { op: 'send'; chatId: string; content: OutContent; messageId: string }
  | { op: 'edit'; chatId: string; messageId: string; text: string }
  | { op: 'react'; chatId: string; messageId: string; emoji: string }
  | { op: 'typing'; chatId: string; on: boolean };

export class FakeTransport implements Transport {
  readonly calls: TransportCall[] = [];
  /** Throw on the next N sends, to exercise retries. */
  failNextSends = 0;
  private onInbound: ((e: RawInbound) => void) | null = null;
  private counter = 0;

  constructor(readonly provider: 'imessage' | 'terminal' = 'imessage') {}

  async start(onInbound: (event: RawInbound) => void): Promise<void> {
    this.onInbound = onInbound;
  }

  async send(chatId: string, content: OutContent): Promise<{ messageId: string }> {
    if (this.failNextSends > 0) {
      this.failNextSends -= 1;
      throw new Error('transport down');
    }
    this.counter += 1;
    const messageId = `spc-msg-${this.counter}`;
    this.calls.push({ op: 'send', chatId, content, messageId });
    return { messageId };
  }

  async edit(chatId: string, messageId: string, text: string): Promise<void> {
    this.calls.push({ op: 'edit', chatId, messageId, text });
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.calls.push({ op: 'react', chatId, messageId, emoji });
  }

  async typing(chatId: string, on: boolean): Promise<void> {
    this.calls.push({ op: 'typing', chatId, on });
  }

  async stop(): Promise<void> {
    this.onInbound = null;
  }

  push(event: RawInbound): void {
    this.onInbound?.(event);
  }

  sends(): Array<Extract<TransportCall, { op: 'send' }>> {
    return this.calls.filter((c): c is Extract<TransportCall, { op: 'send' }> => c.op === 'send');
  }

  /** Mini App cards sent, in order (OutContent kind 'mini_app'). */
  cards(): Array<{ chatId: string; card: Extract<OutContent, { kind: 'mini_app' }> }> {
    return this.sends().flatMap((c) =>
      c.content.kind === 'mini_app' ? [{ chatId: c.chatId, card: c.content }] : [],
    );
  }
}
