/**
 * Holds one sender's texts for a quiet window and delivers the burst as one batch.
 * "hey" / "wait" / "actually thai" within 1.5 s becomes one turn, not three.
 */
export interface BatchItem {
  providerId: string;
  text: string;
  replyToMessageId?: string;
  at: string;
}

export interface Batch {
  key: string;
  items: BatchItem[];
}

export class Batcher {
  private readonly pending = new Map<string, { items: BatchItem[]; timer: NodeJS.Timeout }>();

  constructor(
    private readonly windowMs: number,
    private readonly flush: (batch: Batch) => void | Promise<void>,
  ) {}

  add(key: string, item: BatchItem): void {
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing.timer);
    const items = [...(existing?.items ?? []), item];
    if (this.windowMs === 0) {
      this.pending.delete(key);
      void this.flush({ key, items });
      return;
    }
    const timer = setTimeout(() => {
      this.pending.delete(key);
      void this.flush({ key, items });
    }, this.windowMs);
    this.pending.set(key, { items, timer });
  }

  /** Deliver one sender's batch now, e.g. a clear plan intent that should not wait. */
  flushNow(key: string): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(key);
    void this.flush({ key, items: pending.items });
  }

  /** Deliver everything now, e.g. on shutdown. */
  async drain(): Promise<void> {
    const batches = [...this.pending.entries()].map(([key, p]) => {
      clearTimeout(p.timer);
      return { key, items: p.items };
    });
    this.pending.clear();
    for (const batch of batches) await this.flush(batch);
  }

  get size(): number {
    return this.pending.size;
  }
}

/** Joins a burst into the single inbound message the engine sees. */
export function mergeBatch(items: BatchItem[]): {
  messageId: string;
  text: string;
  replyToMessageId?: string;
  at: string;
} {
  const last = items[items.length - 1]!;
  const replyTo = items.find((i) => i.replyToMessageId)?.replyToMessageId;
  return {
    messageId: last.providerId,
    text: items.map((i) => i.text.trim()).join('\n'),
    ...(replyTo ? { replyToMessageId: replyTo } : {}),
    at: last.at,
  };
}
