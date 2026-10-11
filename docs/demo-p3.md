# P3 demo runbook (bubbles and context)

Owner: Soham (P3). Pairs with P4's demo direction. Server: https://server-production-6ba5.up.railway.app

## Before rehearsals (once)

| Step                                                                                                                                                            | Who           | Check                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------- |
| Railway env has ANTHROPIC_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET, SEED_ON_BOOT=true | Aditya        | `pnpm p3:smoke` shows 5/5 PASS                        |
| Google OAuth client allows `<railway>/oauth/google/callback`                                                                                                    | Soham         | smoke "calendar connect route" PASS                   |
| Judges added as OAuth test users (Google Cloud → Audience → Test users)                                                                                         | Soham         | judge's calendar link does not show 403               |
| Every teammate registered (signup) and has texted their bubble once                                                                                             | Pranav        | their first DM gets the 1/5 question                  |
| Every teammate onboarded, calendar connected, Find My shared with their own bubble number                                                                       | each teammate | final onboarding DM received; "Calendar connected" DM |
| One crew with all four teammates: "my crew is Aditya, Pranav, Mahil" (from Soham), everyone says yes                                                            | all           | everyone gets "<crew> is set"                         |
| Every teammate has a Venmo handle (onboarding Q5)                                                                                                               | all           | Splitter can pick a payer                             |

## Staging, 5 minutes before each run

1. **Absent member**: one teammate (default: Mahil) texts their bubble `busy`. Expect: "Got it, you're busy until ...". Do not reply to the plan's poll or headcount. Do not use Do Not Disturb; Photon cannot read it (docs/spikes/context.md).
2. That teammate needs at least one confirmed hard fact (budget counts), or the engine drops them instead of representing them. Onboarding covers this.
3. Phones on the table, volume up, notifications on (the busy teammate's too, so the audience sees the summary arrive).
4. `pnpm p3:smoke` PASS.

## P3 moments in the demo

| Beat                                   | What happens                                                                                                                               | What to say                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Onboarding (optional live, 60 to 90 s) | A judge texts their bubble; five questions; allergy double-check; calendar link                                                            | "Five questions, once. Allergies get a yes/no, because the bubble never bends on them." |
| Represented member                     | After lock, the busy teammate gets "While you were away, your bubble joined dinner for you: ... I kept to your limits: ... Reply veto ..." | "Mahil was in a meeting. His bubble planned within his limits and told only him."       |
| Inviter                                | Each member: "Alpha Pie, 7:30 PM, table for 4 under ... Add it to your calendar: <link>". Tap it: Add to Calendar                          | "Calendar invite, no app."                                                              |
| Splitter                               | Payer: "You're covering ..."; everyone else: a Venmo link with the amount filled in                                                        | "It rotates by the fairness ledger. Whoever compromised most doesn't front the bill."   |
| Watcher (if dinner is within 45 min)   | Live card: "Ava: here, Ben: ~6 min away". 15+ min late: crew text + the caller asks to hold the table                                      | "It watches arrivals and asks the restaurant to hold the table."                        |
| Learning                               | Someone texts "btw I'm allergic to shellfish": a private "Should I treat that as a hard rule?"                                             | "It learns from chat but asks before it treats anything as a hard rule."                |
| Reaction (after)                       | "that place was mid": next plan ranks that place lower for that person                                                                     | "Feedback without a survey."                                                            |
| Privacy                                | "forget me" then yes: everything gone                                                                                                      | "One text deletes you."                                                                 |

## Fallbacks

| If                                  | Do                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Calendar link 403 for a judge       | They are not a test user. Skip calendar; plans still work.                                                |
| Find My not shared                  | Location falls back to the onboarding neighborhood; the Watcher card says "no location".                  |
| Haiku slow or down                  | Rule extraction takes over automatically; onboarding still works.                                         |
| Represented summary does not arrive | The teammate replied to the plan, so they were "in", not represented. Restage with `busy` and no replies. |
| Wrong fact learned live             | Text `forget that`.                                                                                       |

## Reset between rehearsals

- Ledger history is part of the story. Keep it, or re-seed a fresh database (P1's demo reset) to restart the rotation.
- The busy teammate texts `back` after each run.
- A judge who onboarded can text `forget me` then `yes` to start clean.
