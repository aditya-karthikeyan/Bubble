/**
 * P3 Phase 0 spike: Haiku fact extraction with structured JSON, validated with zod.
 * Uses the repo's FactType so the output drops straight into NewFact.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { FactType } from '@bubbleworks/shared';
import { z } from 'zod';

export const HAIKU = 'claude-haiku-4-5-20251001';

export const ExtractedFact = z.object({
  type: FactType,
  value: z.string(),
  hard: z.boolean(),
  confidence: z.number(),
  /** The phrase that limits the fact in time ("till Friday"), resolved to a date in code. */
  until_phrase: z.string().nullable(),
});

export const Extraction = z.object({ facts: z.array(ExtractedFact) });
export type Extraction = z.infer<typeof Extraction>;

const SYSTEM = `You extract dining facts about the speaker from one chat message.
Return only facts the speaker states about themselves.
hard=true only for diet, allergy, religious_diet, accessibility, budget_max.
Value conventions:
- diet: vegetarian | vegan | pescatarian | gluten_free | dairy_free
- allergy: peanut | tree_nut | shellfish | dairy | gluten | soy | egg | sesame
- religious_diet: halal | kosher | hindu_veg | jain
- accessibility: wheelchair | step_free | quiet
- budget_max: integer dollars per person, e.g. "25"
- cuisine_like / cuisine_avoid: lowercase cuisine key, e.g. "thai"
- neighborhood: free text; favorite_venue: the place name; venmo_handle: "@name"
If a fact is temporary ("broke till Friday"), copy the time phrase into until_phrase; otherwise null.
confidence is 0 to 1. If nothing applies, return an empty list.`;

export async function extractFacts(message: string): Promise<{ result: Extraction; ms: number }> {
  const client = new Anthropic();
  const t0 = performance.now();
  const res = await client.messages.parse({
    model: HAIKU,
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: 'user', content: message }],
    output_config: { format: zodOutputFormat(Extraction) },
  });
  const ms = Math.round(performance.now() - t0);
  // Re-validate so a schema drift fails loudly instead of passing through.
  return { result: Extraction.parse(res.parsed_output), ms };
}
