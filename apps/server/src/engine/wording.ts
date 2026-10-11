/**
 * Wording for private concession asks. Haiku writes one short, warm text to one person; the
 * template is the fallback (no key, timeout, or a draft that names someone else). Nothing here
 * ever mentions another member, their limits, or the group's details beyond the venue.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { MODELS } from '@bubbleworks/shared';
import { z } from 'zod';
import type { ConcessionKind } from './deadlock.js';

export interface AskWordingInput {
  kind: ConcessionKind;
  from: number;
  to: number;
  venueName: string;
  meal: string;
  /** Recipient's first name. The only name allowed in the text. */
  firstName: string;
  /** Names that must not appear (everyone else in the crew). */
  forbiddenNames: string[];
}

export interface AskWriter {
  write(input: AskWordingInput): Promise<string>;
}

export function templateAsk(input: AskWordingInput): string {
  const place = input.venueName;
  if (input.kind === 'budget') {
    return `Hey ${input.firstName}, quick one: ${place} works for everyone for ${input.meal} but runs about $${input.to} a head, a bit over your usual $${input.from}. Okay to stretch to $${input.to} tonight? Reply yes or no.`;
  }
  return `Hey ${input.firstName}, quick one: ${place} works for everyone for ${input.meal} but it is about ${input.to} minutes away instead of ${input.from}. Okay with the extra walk tonight? Reply yes or no.`;
}

export function thankYouText(firstName: string): string {
  return `Thanks ${firstName}, no need after all, someone else covered it. Details coming to the group.`;
}

export function noFitText(kind: 'time' | 'takeout', detail?: string): string {
  return kind === 'time'
    ? `Nothing fits everyone at the original time, but ${detail} works for the whole group. Switching to ${detail} unless someone says veto.`
    : 'Nothing nearby fits everyone tonight. Takeout at someone’s place? Reply "takeout" and I’ll sort the order.';
}

/** Text must be short, name only the recipient, and never mention anyone else. */
export function askTextIsSafe(text: string, input: AskWordingInput): boolean {
  if (text.length < 20 || text.length > 260) return false;
  const lower = text.toLowerCase();
  return !input.forbiddenNames.some((n) => n && lower.includes(n.toLowerCase()));
}

const Draft = z.object({ text: z.string().min(20).max(260) });

const SYSTEM = `You write one private iMessage from a friendly planning assistant to one person.
The group is trying to pick a place to eat and the only thing standing in the way is this person's
own limit. Ask, warmly and in one or two short sentences, whether they would stretch it tonight,
and end with "Reply yes or no." Rules: address only the recipient by first name; never mention,
hint at, or count anyone else; never mention allergies, diets, or anyone's reasons; no emoji; no
guilt; plain text only.`;

export class HaikuAskWriter implements AskWriter {
  private readonly client: Anthropic;

  constructor(options: { apiKey?: string; timeoutMs?: number } = {}) {
    this.client = new Anthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      timeout: options.timeoutMs ?? 6_000,
      maxRetries: 1,
    });
  }

  async write(input: AskWordingInput): Promise<string> {
    try {
      const res = await this.client.messages.parse({
        model: MODELS.fast,
        max_tokens: 200,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content:
              input.kind === 'budget'
                ? `Recipient: ${input.firstName}. Meal: ${input.meal}. Place: ${input.venueName}. Their usual budget is $${input.from} per person; the place runs about $${input.to}.`
                : `Recipient: ${input.firstName}. Meal: ${input.meal}. Place: ${input.venueName}. They usually keep to a ${input.from} minute walk; this one is about ${input.to} minutes.`,
          },
        ],
        output_config: { format: zodOutputFormat(Draft) },
      });
      const text = Draft.parse(res.parsed_output).text.trim();
      return askTextIsSafe(text, input) ? text : templateAsk(input);
    } catch {
      return templateAsk(input);
    }
  }
}

export class TemplateAskWriter implements AskWriter {
  async write(input: AskWordingInput): Promise<string> {
    return templateAsk(input);
  }
}

/** To a member who voted for a cuisine nothing that fits tonight serves. Poll labels read as names. */
export function cuisineSwitchAsk(cuisine: string, venueName: string): string {
  return `${cuisine} won the vote, but no spot like that fits tonight. OK to switch to ${venueName}? Reply yes or no.`;
}

/** To everyone else while the voters are asked. */
export function cuisineSwitchNotice(cuisine: string, venueName: string): string {
  return `${cuisine} won the vote, but no spot like that fits tonight. Checking with its voters about ${venueName}.`;
}
