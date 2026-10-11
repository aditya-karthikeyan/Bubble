/**
 * Post-dinner reactions ("that place was mid", "so good"). Haiku only classifies the message;
 * deterministic code in DbBubbleService.reactTo decides what changes. Owner: P3.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { HAIKU_MODEL } from './extract.js';

export const Reaction = z.object({
  /** True when the message is about the restaurant they just ate at. */
  about_place: z.boolean(),
  sentiment: z.enum(['positive', 'negative', 'neutral']),
});
export type Reaction = z.infer<typeof Reaction>;

export interface ReactionClassifier {
  classify(text: string, venueName: string): Promise<Reaction>;
}

const NEG =
  /\b(mid|meh|bad|trash|mediocre|overrated|bland|gross|nasty|disappointing|never again|not great|wasn'?t (good|great)|mid af|slow|cold food|terrible|awful)\b/i;
const POS =
  /\b(so good|amazing|fire|bussin|delicious|loved|love it|great|banger|perfect|10\/10|again soon|obsessed)\b/i;
const PLACE = /\b(place|spot|restaurant|food|dinner|meal|there|it|that)\b/i;

export class RuleReactionClassifier implements ReactionClassifier {
  async classify(text: string, venueName: string): Promise<Reaction> {
    const t = text.toLowerCase();
    const about = t.includes(venueName.toLowerCase().split(' ')[0] ?? '\u0000') || PLACE.test(t);
    if (!about) return { about_place: false, sentiment: 'neutral' };
    if (NEG.test(t)) return { about_place: true, sentiment: 'negative' };
    if (POS.test(t)) return { about_place: true, sentiment: 'positive' };
    return { about_place: true, sentiment: 'neutral' };
  }
}

export class HaikuReactionClassifier implements ReactionClassifier {
  private readonly client: Anthropic;

  constructor(
    options: { apiKey?: string } = {},
    private readonly fallback: ReactionClassifier = new RuleReactionClassifier(),
  ) {
    this.client = new Anthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      timeout: 8_000,
      maxRetries: 1,
    });
  }

  async classify(text: string, venueName: string): Promise<Reaction> {
    try {
      const res = await this.client.messages.parse({
        model: HAIKU_MODEL,
        max_tokens: 64,
        system:
          'A friend group just had dinner at a restaurant. Classify one message from a member: ' +
          'is it about that restaurant or its food, and is it positive, negative, or neutral? ' +
          'Slang: "mid" is negative, "fire" and "bussin" are positive.',
        messages: [{ role: 'user', content: `Restaurant: ${venueName}\nMessage: ${text}` }],
        output_config: { format: zodOutputFormat(Reaction) },
      });
      return Reaction.parse(res.parsed_output);
    } catch {
      return this.fallback.classify(text, venueName);
    }
  }
}

/** Gate before classification: only texts that could be a verdict. */
export function mightBeReaction(text: string): boolean {
  return NEG.test(text) || POS.test(text);
}
