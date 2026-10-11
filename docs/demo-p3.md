# P3 demo runbook (bubbles and context)

Owner: Soham (P3). Pairs with P4's demo direction. Server: https://server-production-6ba5.up.railway.app

## Before rehearsals (once)

| Step                                                                                                                                                            | Who           | Check                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------- |
| Railway env has ANTHROPIC_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET, SEED_ON_BOOT=true | Aditya        | `pnpm p3:smoke` shows 5/5 PASS                                    |
| Google OAuth client allows `<railway>/oauth/google/callback`                                                                                                    | Soham         | smoke "calendar connect route" PASS                               |
| Judges added as OAuth test users (Google Cloud → Audience → Test users)                                                                                         | Soham         | judge's calendar link does not show 403                           |
| Every teammate registered (signup) and has texted their bubble once                                                                                             | Pranav        | their first DM gets the 1/5 question                              |
| Every teammate onboarded, calendar connected, location pin sent to their bubble (+ → Location → Share)                                                          | each teammate | final onboarding DM; "Calendar connected"; "Got your location 📍" |
| One crew with all four teammates: "my crew is Aditya, Pranav, Mahil" (from Soham), everyone says yes                                                            | all           | everyone gets "<crew> is set"                                     |
| At least two teammates gave a payment method at 5/5 (Venmo @, Cash App $, Zelle phone/email, PayPal)                                                            | all           | Splitter can pick a payer                                         |

## Staging, 5 minutes before each run

1. **Absent member**: one teammate (default: Mahil) texts their bubble `busy`. Expect: "Got it, you're busy until ...". Do not reply to the plan's poll or headcount. Do not use Do Not Disturb; Photon cannot read it (docs/spikes/context.md).
2. That teammate needs at least one confirmed hard fact (budget counts), or the engine drops them instead of representing them. Onboarding covers this.
3. Phones on the table, volume up, notifications on (the busy teammate's too, so the audience sees the summary arrive).
4. `pnpm p3:smoke` PASS.
5. For the payment beat, steer the style poll to **Sit-down**. Fast food / takeout means no split at all, on purpose.

## P3 moments in the demo

| Beat                                   | What happens                                                                                                                                                                                                                                    | What to say                                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Onboarding (optional live, 60 to 90 s) | A judge texts their bubble; five questions; allergy double-check; calendar link; "send me your location right here"                                                                                                                             | "Five questions, once. Allergies get a yes/no, because the bubble never bends on them."                                                           |
| Fix a typo (optional)                  | At 1/5 answer "vegetarian", then edit the message to "vegan": "Saw your edit. Updated: you eat vegan." Or text "wait i messed up" / "oops I meant vegan"                                                                                        | "Edit the text like you would with a friend. It just updates."                                                                                    |
| Hard diet limits                       | "no pork or beef" at 1/5 saves two hard limits; hot dog, burger, BBQ and steakhouse places drop out                                                                                                                                             | "No pork means no pork. It is never offered as a compromise."                                                                                     |
| Represented member                     | After lock, the busy teammate gets "While you were away, your bubble joined dinner for you: ... I kept to your limits: ... Reply veto ..."                                                                                                      | "Mahil was in a meeting. His bubble planned within his limits and told only him."                                                                 |
| Inviter                                | Each member: "Alpha Pie, 7:30 PM, table for 4 under ... Add it to your calendar: <link>". Tap it: Add to Calendar                                                                                                                               | "Calendar invite, no app."                                                                                                                        |
| Splitter                               | Sit-down only. Payer: "You're covering ...". Everyone else: one DM with the payer's methods, amount filled in (Venmo / Cash App / PayPal links, Zelle as text), the ones they share first. Anyone who said "I don't want to split" gets nothing | "It rotates by the fairness ledger. Whoever compromised most doesn't front the bill. Fast food? Everyone pays at the counter, so it stays quiet." |
| Watcher (if dinner is within 45 min)   | Live card: "Ava: here, Ben: on the way". 15+ min late: the crew hears "Someone's running a bit late", only the late person gets their ETA, and the caller asks to hold the table                                                                | "It watches arrivals and asks the restaurant to hold the table."                                                                                  |
| Learning                               | Someone texts "btw I'm allergic to shellfish": a private "Should I treat that as a hard rule?"                                                                                                                                                  | "It learns from chat but asks before it treats anything as a hard rule."                                                                          |
| Reaction (after)                       | "that place was mid": next plan ranks that place lower for that person                                                                                                                                                                          | "Feedback without a survey."                                                                                                                      |
| Privacy                                | "forget me" then yes: everything gone                                                                                                                                                                                                           | "One text deletes you."                                                                                                                           |

## Fallbacks

| If                                  | Do                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Calendar link 403 for a judge       | They are not a test user. Skip calendar; plans still work.                                                                                                         |
| No location                         | Send a pin (+ → Location → Share); it counts for 6 hours. Without one, location falls back to the onboarding neighborhood and the Watcher card says "no location". |
| Haiku slow or down                  | Rule extraction takes over automatically; onboarding still works.                                                                                                  |
| Represented summary does not arrive | The teammate replied to the plan, so they were "in", not represented. Restage with `busy` and no replies.                                                          |
| Wrong fact learned live             | Text `forget that`.                                                                                                                                                |
| Wrong onboarding answer             | Edit the message, or text `go back` / `change my diet` (budget, area, favorites, venmo work too).                                                                  |
| No payment messages after Booked    | Fast-food venue (by design), nobody gave a payment method, or everyone but one said they don't split.                                                              |

## Reset between rehearsals

- Ledger history is part of the story. Keep it, or re-seed a fresh database (P1's demo reset) to restart the rotation.
- The busy teammate texts `back` after each run.
- A judge who onboarded can text `forget me` then `yes` to start clean.
