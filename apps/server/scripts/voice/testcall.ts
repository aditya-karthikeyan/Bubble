/**
 * pnpm p4:testcall
 * Places one outbound call to TEST_CALL_NUMBER and reports the outcome plus LLM latency.
 */
import { z } from 'zod';
import { elevenlabs, env } from './lib.js';

const CallResponse = z.object({
  success: z.boolean(),
  message: z.string(),
  conversation_id: z.string().nullish(),
});

const Conversation = z.object({
  status: z.string(),
  transcript: z
    .array(
      z.object({
        role: z.string(),
        conversation_turn_metrics: z
          .object({
            metrics: z
              .record(z.string(), z.object({ elapsed_time: z.number() }).partial())
              .nullish(),
          })
          .nullish(),
      }),
    )
    .default([]),
  metadata: z
    .object({ call_duration_secs: z.number().nullish(), termination_reason: z.string().nullish() })
    .partial()
    .default({}),
  analysis: z.object({ data_collection_results: z.unknown() }).partial().nullish(),
});

async function main(): Promise<void> {
  const t0 = performance.now();
  const call = CallResponse.parse(
    await elevenlabs('POST', '/twilio/outbound-call', {
      agent_id: env('ELEVENLABS_AGENT_ID'),
      agent_phone_number_id: env('ELEVENLABS_PHONE_NUMBER_ID'),
      to_number: env('TEST_CALL_NUMBER'),
      // Real calls need every variable the agent's first message and prompt use.
      conversation_initiation_client_data: {
        dynamic_variables: {
          venue_name: 'Test Bistro',
          party_size: 4,
          preferred_time: '7:00 PM',
          window_start: '6:30 PM',
          window_end: '8:00 PM',
          booking_name: 'Mahil',
          callback_number: process.env['TWILIO_PHONE_NUMBER'] ?? 'this number',
          table_notes: 'none',
          // Test-number calls skip the AI disclosure; real bookings keep it.
          opener: 'Hey! Quick question, do you guys take reservations?',
        },
      },
      telephony_call_config: { ringing_timeout_secs: 20 },
    }),
  );
  console.log(
    `dial request: ${call.success ? 'ok' : 'failed'} in ${(performance.now() - t0).toFixed(0)} ms (${call.message})`,
  );
  if (!call.conversation_id) throw new Error('no conversation_id returned');

  let convo: z.infer<typeof Conversation>;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    convo = Conversation.parse(await elevenlabs('GET', `/conversations/${call.conversation_id}`));
    if (convo.status === 'done' || convo.status === 'failed') break;
    process.stdout.write(`  status: ${convo.status}\r`);
  }

  const ttfb = convo.transcript
    .filter((t) => t.role === 'agent')
    .map((t) => t.conversation_turn_metrics?.metrics?.['convai_llm_service_ttfb']?.elapsed_time)
    .filter((v): v is number => typeof v === 'number');
  const avg = ttfb.length ? (ttfb.reduce((a, b) => a + b, 0) / ttfb.length).toFixed(2) : 'n/a';

  console.log(`\nconversation: ${call.conversation_id}`);
  console.log(`status:       ${convo.status}`);
  console.log(`duration:     ${convo.metadata.call_duration_secs ?? '?'} s`);
  console.log(`ended by:     ${convo.metadata.termination_reason ?? '?'}`);
  console.log(`turns:        ${convo.transcript.length}`);
  console.log(`LLM TTFB avg: ${avg} s over ${ttfb.length} agent turns`);
  console.log(
    `collected:    ${JSON.stringify(convo.analysis?.data_collection_results ?? {}, null, 2)}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
