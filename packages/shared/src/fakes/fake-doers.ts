/**
 * FakeDoers: Inviter, Splitter, and Watcher that record every call and succeed.
 */
import type { BookingSummary, DoerPorts, DoerResult } from '../ports.js';

export type RecordedDoerCall =
  | { doer: 'inviter'; input: BookingSummary & { idempotencyKey: string } }
  | { doer: 'splitter'; input: BookingSummary & { idempotencyKey: string } }
  | { doer: 'watcher'; action: 'start'; input: BookingSummary }
  | { doer: 'watcher'; action: 'stop'; planId: string };

export class FakeDoers implements DoerPorts {
  readonly calls: RecordedDoerCall[] = [];
  private readonly seenKeys = new Set<string>();
  readonly watching = new Set<string>();

  readonly inviter = {
    send: async (input: BookingSummary & { idempotencyKey: string }): Promise<DoerResult> => {
      if (this.seenKeys.has(input.idempotencyKey)) return { ok: true, detail: 'duplicate' };
      this.seenKeys.add(input.idempotencyKey);
      this.calls.push({ doer: 'inviter', input });
      return { ok: true, detail: `invited ${input.members.length}` };
    },
  };

  readonly splitter = {
    send: async (input: BookingSummary & { idempotencyKey: string }): Promise<DoerResult> => {
      if (this.seenKeys.has(input.idempotencyKey)) return { ok: true, detail: 'duplicate' };
      this.seenKeys.add(input.idempotencyKey);
      this.calls.push({ doer: 'splitter', input });
      return { ok: true, detail: `split ${input.members.length} ways` };
    },
  };

  readonly watcher = {
    start: async (input: BookingSummary): Promise<void> => {
      this.watching.add(input.planId);
      this.calls.push({ doer: 'watcher', action: 'start', input });
    },
    stop: async (input: { planId: string }): Promise<void> => {
      this.watching.delete(input.planId);
      this.calls.push({ doer: 'watcher', action: 'stop', planId: input.planId });
    },
  };

  reset(): void {
    this.calls.length = 0;
    this.seenKeys.clear();
    this.watching.clear();
  }
}
