/**
 * pnpm p4:number
 * Imports the Twilio caller number into ElevenLabs and assigns it to the caller agent.
 * Spectrum SIP needs Photon Business, so calls go out through Twilio instead.
 */
import { z } from 'zod';
import { elevenlabs, env, setEnv } from './lib.js';

async function main(): Promise<void> {
  const existing = process.env['ELEVENLABS_PHONE_NUMBER_ID'];
  if (existing) {
    console.log(`Already imported: ${existing}`);
    return;
  }
  const res = await elevenlabs('POST', '/phone-numbers', {
    provider: 'twilio',
    label: 'Bubbleworks caller',
    phone_number: env('TWILIO_PHONE_NUMBER'),
    sid: env('TWILIO_ACCOUNT_SID'),
    token: env('TWILIO_AUTH_TOKEN'),
    agent_id: env('ELEVENLABS_AGENT_ID'),
    // Texts belong to the Photon bubbles, not the caller.
    enable_sms: false,
  });
  const { phone_number_id } = z.object({ phone_number_id: z.string() }).parse(res);
  setEnv('ELEVENLABS_PHONE_NUMBER_ID', phone_number_id);
  console.log(`Imported number ${phone_number_id}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
