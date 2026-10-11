/** The two ElevenLabs Agents calls the caller needs: dial out over Twilio, read a conversation. */
import { z } from 'zod';
import { Conversation } from './conversation.js';

const BASE = 'https://api.elevenlabs.io/v1/convai';

export interface OutboundCallInput {
  toNumber: string;
  dynamicVariables: Record<string, string | number>;
  ringTimeoutSecs: number;
}

export interface ElevenLabsApi {
  outboundCall(
    input: OutboundCallInput,
  ): Promise<{ conversationId: string; callSid: string | null }>;
  getConversation(conversationId: string): Promise<Conversation>;
}

const OutboundResponse = z.object({
  success: z.boolean(),
  message: z.string(),
  conversation_id: z.string().nullish(),
  callSid: z.string().nullish(),
});

export class ElevenLabsHttp implements ElevenLabsApi {
  constructor(
    private readonly options: { apiKey: string; agentId: string; phoneNumberId: string },
  ) {}

  async outboundCall(input: OutboundCallInput) {
    const res = OutboundResponse.parse(
      await this.request('POST', '/twilio/outbound-call', {
        agent_id: this.options.agentId,
        agent_phone_number_id: this.options.phoneNumberId,
        to_number: input.toNumber,
        conversation_initiation_client_data: { dynamic_variables: input.dynamicVariables },
        telephony_call_config: { ringing_timeout_secs: input.ringTimeoutSecs },
      }),
    );
    if (!res.success || !res.conversation_id) {
      throw new Error(`outbound call refused: ${res.message}`);
    }
    return { conversationId: res.conversation_id, callSid: res.callSid ?? null };
  }

  async getConversation(conversationId: string) {
    return Conversation.parse(await this.request('GET', `/conversations/${conversationId}`));
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'xi-api-key': this.options.apiKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(`ElevenLabs ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? (JSON.parse(text) as unknown) : {};
  }
}
