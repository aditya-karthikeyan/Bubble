# Voice spike (P4)

Caller agent on ElevenLabs Agents, dialing out through a Twilio number. (Spectrum SIP needs Photon Business, so it was dropped; see P2's Plan B update.)

## What works

- Agent `Bubbleworks Caller` created through the API (`pnpm p4:agent`, idempotent: updates when `ELEVENLABS_AGENT_ID` is set).
- LLM: ElevenLabs lists Claude Haiku 4.5 as `claude-haiku-4-5`, so no custom LLM endpoint is needed.
- TTS: `eleven_flash_v2`. The API rejects `eleven_flash_v2_5` for English agents ("must use turbo or flash v2").
- Built-in tools: `end_call`, `voicemail_detection`, `play_keypad_touch_tone`.
- Data collection: booked, confirmed_time, name_on_reservation, notes, needs_human, failure_reason.
- Opener: "Hi, this is an AI assistant calling for {{booking_name}}. Do you take reservations?" (disclosure first, per invariant 5). Walk-in-only venues end with booked=false, failure_reason=other, notes "walk-in only" plus the wait.

## Twilio number

- `POST /v1/convai/phone-numbers` with `provider: twilio`, `sid` (Account SID), `token` (Auth Token), `enable_sms: false`.
- Trial accounts can only call verified caller IDs, and every trial call opens with a Twilio notice the callee must press a key to pass. Real restaurant calls need an upgraded account.
- Caller ID is the Twilio number, not a bubble number.

## Calls and webhooks

- Outbound: `POST /v1/convai/twilio/outbound-call`, `telephony_call_config.ringing_timeout_secs` = 20.
- Post-call webhook: header `ElevenLabs-Signature`; verify the raw body with the SDK's `constructEvent`. Results at `data.analysis.data_collection_results`, dynamic variables at `data.conversation_initiation_client_data.dynamic_variables`. Retries resend, so dedupe by `conversation_id`.
- API keys need the `convai_write` permission, or agent creation returns 401.

## Docs

- https://elevenlabs.io/docs/eleven-agents/api-reference/phone-numbers/create
- https://elevenlabs.io/docs/eleven-agents/api-reference/integrations/twilio/outbound-call
- https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks
