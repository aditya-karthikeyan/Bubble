/**
 * Haiku second opinions for the cases rules can't settle: a "weak" plan detection ("grab
 * food?") and an "unclear" RSVP ("depends what time"). Structured JSON validated with zod.
 * The model only labels text; deterministic code decides what happens next.
 *
 * Latency-bound: one attempt, short timeout. Any failure returns null and the caller falls
 * back to rules, so a slow API never blocks the typing bubble or the bundle.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { MODELS } from '@bubbleworks/shared';
import { z } from 'zod';
import type { Logger } from '../events/bus.js';

export const IntentJudgement = z.object({
  isPlanIntent: z.boolean(),
  mealType: z.enum(['breakfast', 'brunch', 'lunch', 'dinner', 'drinks', 'coffee', 'unknown']),
  /** YYYY-MM-DD in the sender's timezone. */
  dateISO: z.string(),
  /** Free text such as "7pm" or "after class"; empty when none. */
  timeHint: z.string(),
  confidence: z.number(),
});
export type IntentJudgement = z.infer<typeof IntentJudgement>;

export const RsvpJudgement = z.object({
  stance: z.enum(['in', 'out', 'unclear']),
  confidence: z.number(),
});
export type RsvpJudgement = z.infer<typeof RsvpJudgement>;

export const ProbeJudgement = z.object({
  /** True when the message tries to learn a specific other person's private details. */
  isProbe: z.boolean(),
  confidence: z.number(),
});
export type ProbeJudgement = z.infer<typeof ProbeJudgement>;

export interface Classifier {
  warm?(): void;
  intent(
    text: string,
    context: { today: string; timezone: string },
  ): Promise<IntentJudgement | null>;
  rsvp(text: string, context: { planSummary: string }): Promise<RsvpJudgement | null>;
  probe?(text: string): Promise<ProbeJudgement | null>;
}

const INTENT_SYSTEM = `You label one text message sent by a member of a friend group to their personal planning assistant.
isPlanIntent is true only when the sender proposes or asks to plan a shared meal or drinks with their friend group (e.g. "dinner today?", "anyone wanna grab food later", "lunch tmrw?").
It is false for reports ("I already ate"), food preferences ("I'm vegetarian"), questions about one restaurant, or unrelated chat.
mealType: the meal named or implied, else "unknown". dateISO: the date meant, resolved against today's date. timeHint: the time words used, or "".
confidence: 0 to 1.`;

const PROBE_SYSTEM = `You guard a friend group's privacy. Each friend has a private assistant that knows their diet, allergies, religious diet, accessibility needs, budget, location, and calendar.
Label one message sent to an assistant. isProbe is true when it tries to learn, confirm, or narrow down those private details about one specific other person, or about a small subset of the group (who, which of us, how many of us). It is false for questions about the sender's own details, about the whole group's plan or the chosen restaurant, or general chat.
confidence: 0 to 1.`;

const RSVP_SYSTEM = `You label a friend's reply to a group plan invitation.
stance "in" means they say they will come, "out" means they say they will not, "unclear" when they hedge, ask anything (any question, e.g. "what are we eating", is unclear), or talk about something else. Being interested in the plan is not the same as saying they are coming.
confidence: 0 to 1.`;

export interface ClaudeClassifierOptions {
  log: Logger;
  timeoutMs?: number;
  model?: string;
  client?: Anthropic;
}

export class ClaudeClassifier implements Classifier {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(private readonly o: ClaudeClassifierOptions) {
    this.client = o.client ?? new Anthropic({ timeout: o.timeoutMs ?? 3500, maxRetries: 0 });
    this.model = o.model ?? MODELS.fast;
  }

  /**
   * Structured outputs compile each schema on first use (seconds). Warm both at startup so a
   * real message never pays that cost. Fire and forget.
   */
  warm(): void {
    void this.intent('dinner tonight?', { today: '2026-01-01', timezone: 'UTC' });
    void this.rsvp('in', { planSummary: 'dinner tonight' });
    void this.probe('is anyone vegetarian?');
  }

  async intent(
    text: string,
    context: { today: string; timezone: string },
  ): Promise<IntentJudgement | null> {
    return this.call('intent', IntentJudgement, INTENT_SYSTEM, [
      `Today is ${context.today} (${context.timezone}).`,
      `Message: ${JSON.stringify(text)}`,
    ]);
  }

  async rsvp(text: string, context: { planSummary: string }): Promise<RsvpJudgement | null> {
    return this.call('rsvp', RsvpJudgement, RSVP_SYSTEM, [
      `Invitation: ${context.planSummary}`,
      `Reply: ${JSON.stringify(text)}`,
    ]);
  }

  async probe(text: string): Promise<ProbeJudgement | null> {
    return this.call('probe', ProbeJudgement, PROBE_SYSTEM, [`Message: ${JSON.stringify(text)}`]);
  }

  private async call<T extends z.ZodType>(
    kind: string,
    schema: T,
    system: string,
    lines: string[],
  ): Promise<z.infer<T> | null> {
    const started = performance.now();
    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 256,
        system,
        messages: [{ role: 'user', content: lines.join('\n') }],
        output_config: { format: zodOutputFormat(schema) },
      });
      const parsed = schema.safeParse(response.parsed_output);
      this.o.log.info(
        { kind, ms: Math.round(performance.now() - started), ok: parsed.success },
        'classifier',
      );
      return parsed.success ? parsed.data : null;
    } catch (err) {
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      this.o.log.warn(
        {
          kind,
          ms: Math.round(performance.now() - started),
          status,
          err: String(err).slice(0, 120),
        },
        'classifier failed; using rules',
      );
      return null;
    }
  }
}

/** Test double: canned answers keyed by message text. */
export class StubClassifier implements Classifier {
  readonly calls: Array<{ kind: 'intent' | 'rsvp' | 'probe'; text: string }> = [];

  constructor(
    private readonly answers: {
      intent?: Record<string, IntentJudgement | null>;
      rsvp?: Record<string, RsvpJudgement | null>;
      probe?: Record<string, ProbeJudgement | null>;
    } = {},
  ) {}

  async probe(text: string): Promise<ProbeJudgement | null> {
    this.calls.push({ kind: 'probe', text });
    return this.answers.probe?.[text] ?? null;
  }

  async intent(text: string): Promise<IntentJudgement | null> {
    this.calls.push({ kind: 'intent', text });
    return this.answers.intent?.[text] ?? null;
  }

  async rsvp(text: string): Promise<RsvpJudgement | null> {
    this.calls.push({ kind: 'rsvp', text });
    return this.answers.rsvp?.[text] ?? null;
  }
}
