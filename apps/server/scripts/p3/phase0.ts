/**
 * pnpm p3:phase0
 * Prints the Haiku fact extraction, tonight's free/busy, the test teammate's Find My location
 * age, and their Focus state. Never prints secrets, coordinates, or the teammate's address.
 */
import { getFreeBusyTonight } from './calendar.js';
import { extractFacts } from './haiku.js';
import { probeSignals } from './imsg.js';

async function section(name: string, fn: () => Promise<unknown>): Promise<void> {
  console.log(`\n== ${name} ==`);
  try {
    console.log(JSON.stringify(await fn(), null, 2));
  } catch (err) {
    console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

await section('Haiku fact extraction', () =>
  extractFacts(
    "I'm allergic to peanuts, vegetarian, and broke till Friday so nothing over $20. Love Thai.",
  ),
);
await section('Google Calendar free/busy tonight', getFreeBusyTonight);
await section('Find My location + Focus presence', () =>
  probeSignals(process.env['P3_TEST_ADDRESS']),
);
