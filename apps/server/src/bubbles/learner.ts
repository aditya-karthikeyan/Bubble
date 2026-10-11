/**
 * Passive learning: a background worker that reads crew and DM messages and learns facts.
 * Owner: P3. enqueue() returns immediately, so the plan path never waits on Haiku.
 */
import { silentLogger, type Logger } from '../events/bus.js';
import type { ExtractedFact, FactExtractor } from './extract.js';

export interface LearnInput {
  messageId: string;
  userId: string;
  text: string;
  at: string;
}

export interface LearnerOptions {
  extractor: FactExtractor;
  /** Saves what was learned. The service applies merge rules and asks about hard facts. */
  apply: (input: LearnInput, facts: ExtractedFact[]) => Promise<void>;
  concurrency?: number;
  /** Oldest messages drop first past this, so a burst cannot grow memory without bound. */
  maxQueue?: number;
  log?: Logger;
}

/** Cheap gate before Haiku: skip texts that cannot state a dining fact about the sender. */
export function mightContainFact(text: string): boolean {
  const t = text.toLowerCase();
  if (t.trim().length < 6) return false;
  if (/\$\s?\d|\b\d{2}\s?(bucks|dollars)\b/.test(t)) return true;
  return /allerg|vegan|vegetarian|veggie|pescatarian|gluten|dairy|lactose|halal|kosher|jain|wheelchair|stairs|budget|broke|cheap|expensive|pricey|spicy|\bhate\b|\blove\b|\bcraving\b|favorite|fav\b|can'?t (eat|have|do)|don'?t (eat|like)|not a fan|obsessed|\bmid\b|venmo|i live|i'?m (in|near|by|around)/.test(
    t,
  );
}

export class PassiveLearner {
  private readonly queue: LearnInput[] = [];
  private readonly seen = new Set<string>();
  private running = 0;
  private idleWaiters: Array<() => void> = [];
  /** Facts found per recent message id, and callers waiting on a message still in the queue. */
  private readonly found = new Map<string, number>();
  private readonly foundWaiters = new Map<string, Array<(facts: number) => void>>();
  readonly stats = { enqueued: 0, skipped: 0, processed: 0, dropped: 0, failed: 0, factsFound: 0 };

  constructor(private readonly o: LearnerOptions) {}

  /** Non-blocking. Duplicate message ids and texts with no possible fact are skipped. */
  enqueue(input: LearnInput): void {
    if (this.seen.has(input.messageId)) return;
    this.seen.add(input.messageId);
    if (this.seen.size > 10_000) this.seen.delete(this.seen.values().next().value!);
    if (!mightContainFact(input.text)) {
      this.stats.skipped++;
      this.settle(input.messageId, 0);
      return;
    }
    this.queue.push(input);
    this.stats.enqueued++;
    const max = this.o.maxQueue ?? 500;
    while (this.queue.length > max) {
      const dropped = this.queue.shift()!;
      this.stats.dropped++;
      this.settle(dropped.messageId, 0);
    }
    this.pump();
  }

  /** "forget me": drop this person's queued texts. */
  forget(userId: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]!.userId === userId) this.settle(this.queue.splice(i, 1)[0]!.messageId, 0);
    }
  }

  /**
   * How many facts the learner found in a message, once it has read it (0 when it skipped,
   * dropped, or failed on it, or never saw it). Lets the bubble answer a DM nothing else did.
   */
  whenLearned(messageId: string): Promise<number> {
    const done = this.found.get(messageId);
    if (done !== undefined) return Promise.resolve(done);
    if (!this.seen.has(messageId)) return Promise.resolve(0);
    return new Promise((resolve) => {
      const waiting = this.foundWaiters.get(messageId) ?? [];
      waiting.push(resolve);
      this.foundWaiters.set(messageId, waiting);
    });
  }

  private settle(messageId: string, facts: number): void {
    this.found.set(messageId, facts);
    if (this.found.size > 1_000) this.found.delete(this.found.keys().next().value!);
    const waiting = this.foundWaiters.get(messageId);
    this.foundWaiters.delete(messageId);
    for (const resolve of waiting ?? []) resolve(facts);
  }

  /** Resolves when the queue is empty and nothing is running. For tests and the demo. */
  idle(): Promise<void> {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private pump(): void {
    const max = this.o.concurrency ?? 3;
    while (this.running < max && this.queue.length) {
      const next = this.queue.shift()!;
      this.running++;
      void this.process(next).finally(() => {
        this.running--;
        this.pump();
        if (!this.running && !this.queue.length) {
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          for (const w of waiters) w();
        }
      });
    }
  }

  private async process(input: LearnInput): Promise<void> {
    const log = this.o.log ?? silentLogger;
    const t0 = performance.now();
    let found = 0;
    try {
      const facts = await this.o.extractor.extract(input.text, 'chat');
      if (facts.length) await this.o.apply(input, facts);
      found = facts.length;
      this.stats.processed++;
      this.stats.factsFound += facts.length;
      log.debug(
        {
          userId: input.userId,
          messageId: input.messageId,
          facts: facts.length,
          ms: Math.round(performance.now() - t0),
        },
        'learned from message',
      );
    } catch (err) {
      this.stats.failed++;
      log.warn(
        { userId: input.userId, messageId: input.messageId, err: (err as Error).message },
        'learning failed',
      );
    } finally {
      this.settle(input.messageId, found);
    }
  }
}
