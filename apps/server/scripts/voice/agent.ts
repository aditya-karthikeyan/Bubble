/**
 * pnpm p4:agent
 * Creates the ElevenLabs caller agent, or updates it in place when ELEVENLABS_AGENT_ID is set.
 */
import { z } from 'zod';
import { elevenlabs, env, setEnv } from './lib.js';

const PROMPT = `You're phoning a restaurant to book a table for a guest. Sound like a friendly, relaxed person on the phone: casual words, contractions, no scripts or lists.

Booking details:
- Restaurant: {{venue_name}}
- Party size: {{party_size}}
- Preferred time: {{preferred_time}}
- Acceptable window: {{window_start}} to {{window_end}}
- Name for the reservation: {{booking_name}}
- Callback number: {{callback_number}}
- Table notes: {{table_notes}}

Rules:
1. If anyone asks whether you're a person or a bot, say plainly that you're an AI assistant booking for {{booking_name}}. Never claim to be human.
2. If they don't take reservations, ask how long the walk-in wait usually is for {{party_size}} around {{preferred_time}}, thank them, and end the call. Record booked as false, failure_reason as other, and put "walk-in only" plus the wait in notes.
3. If they do, ask for the preferred time first. Accept any time inside the window. Never accept a time outside it.
4. If they are full, ask whether a waitlist exists or any time inside the window opens up.
5. Never give card or payment details. If they require a deposit or card to hold, say the guest will call back to arrange it, then end the call politely.
6. Use the keypad tool to get through phone menus when one answers.
7. If you reach voicemail, hang up without leaving a message.
8. Wait on hold at most two minutes, then end the call.
9. Once the time is agreed, if the table notes are not "none", mention them once, as notes for the table.
10. Confirm back the time, party size, and name before ending.
11. One short sentence per turn, one question at a time. Phone lines lag, so after "yeah" or "mm-hmm" carry on from where you were instead of starting over.
12. Never share anything about the guests beyond the booking details above.`;

function systemTool(name: string) {
  return { type: 'system', name, description: '', params: { system_tool_type: name } };
}

const body = {
  name: 'Bubbleworks Caller',
  conversation_config: {
    agent: {
      // Each call path sends its own opener: real bookings disclose, test-number calls don't.
      first_message: '{{opener}}',
      language: 'en',
      dynamic_variables: {
        dynamic_variable_placeholders: {
          venue_name: 'Test Bistro',
          party_size: 4,
          preferred_time: '7:00 PM',
          window_start: '6:30 PM',
          window_end: '8:00 PM',
          booking_name: 'Mahil',
          callback_number: '+15555550100',
          table_notes: 'none',
          opener: 'Hi, this is an AI assistant calling for Mahil. Do you take reservations?',
        },
      },
      prompt: {
        prompt: PROMPT,
        llm: 'claude-haiku-4-5',
        temperature: 0,
        built_in_tools: {
          end_call: systemTool('end_call'),
          voicemail_detection: systemTool('voicemail_detection'),
          play_keypad_touch_tone: systemTool('play_keypad_touch_tone'),
        },
      },
    },
    // English agents must use flash v2 or turbo; v2.5 is rejected.
    tts: { model_id: 'eleven_flash_v2' },
    // Patient turn-taking: short acknowledgements on a phone line shouldn't cut the agent off.
    turn: { turn_eagerness: 'patient' },
  },
  platform_settings: {
    data_collection: {
      booked: {
        type: 'boolean',
        description: 'True only if the restaurant confirmed a reservation.',
      },
      confirmed_time: {
        type: 'string',
        description:
          'The reservation time the restaurant confirmed, e.g. 7:15 PM. Empty if not booked.',
      },
      name_on_reservation: { type: 'string', description: 'The name the reservation is under.' },
      notes: {
        type: 'string',
        description:
          'Anything else the restaurant said that matters: waitlist, seating, time limits.',
      },
      needs_human: {
        type: 'boolean',
        description:
          'True only if the restaurant requires a deposit or card, or asks to speak with the guest directly. False for confusion, a bad line, or a plain no.',
      },
      failure_reason: {
        type: 'string',
        enum: ['no_answer', 'voicemail', 'full', 'ivr_stuck', 'deposit_required', 'other'],
        description: 'Why the booking failed. Empty if booked.',
      },
    },
  },
};

async function main(): Promise<void> {
  env('ELEVENLABS_API_KEY');
  const id = process.env['ELEVENLABS_AGENT_ID'];
  if (id) {
    await elevenlabs('PATCH', `/agents/${id}`, body);
    console.log(`Updated agent ${id}`);
    return;
  }
  const { agent_id } = z
    .object({ agent_id: z.string() })
    .parse(await elevenlabs('POST', '/agents/create', body));
  setEnv('ELEVENLABS_AGENT_ID', agent_id);
  console.log(`Created agent ${agent_id}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
