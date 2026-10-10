# Bubbleworks Build Kit: Overview

## How to use this kit

Each person opens Claude Code in an empty folder and sends one first message: the God Prompt, then their own Role Prompt, pasted together. Claude Code then runs setup, walks the person through anything needing a browser, and starts Phase 0.

1. Open 01-God-Prompt.md and copy everything.
2. Open your role file (P1, P2, P3, or P4) and copy everything.
3. Paste both into Claude Code as one message. Send.
4. Do only what Claude Code asks: open a link, click through a login, paste a value into the .env file, or confirm something on your phone.
5. When Claude Code prints a TEAM MESSAGE block, copy the block and paste the block into the right teammate's Claude Code (or into every teammate's for TO: ALL).
6. When Claude Code asks you to confirm a phase, check the result on your screen or phone, then reply "confirmed" or describe what looks wrong.

P1 starts first and creates the repo. P2, P3, and P4 run account setup and their Phase 0 spikes in a scratch folder until P1 sends the repo link, then clone and continue there. If a Claude Code session restarts, paste both prompts again plus the line: "Resume. Read docs/STATUS.md and your role log, then tell me where we left off."

## Roles and models

Fable runs P1 because P1 owns the hardest and most cross-cutting work: the repo, the shared contracts, the plan engine, the solver, and every merge. The three Opus 5.5 sessions own one product surface each.

| Role                      | Person | Model           | Owns                                                                                                                              | Accounts owned              |
| ------------------------- | ------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| P1 Core and Integration   | Aditya | Claude Fable    | Repo, contracts, database, plan state machine, venues, solver, deadlock breaker, edge cases, timers, Railway, merges              | GitHub repo, Railway        |
| P2 Messaging and Surfaces | Pranav | Claude Opus 5.5 | Spectrum integration, plan detection, polls, live card, group rename and background, link drop, safety layer                      | Photon (Spectrum line)      |
| P3 Bubbles and Context    | Soham  | Claude Opus 5.5 | Onboarding, facts, passive learning, Calendar, Find My, Focus, absent representation, Inviter, Splitter, Watcher, fairness ledger | Google Cloud, Anthropic API |
| P4 Voice and Live Page    | Mahil  | Claude Opus 5.5 | ElevenLabs caller agent, call webhooks and fallbacks, live deliberation page on Vercel, demo direction                            | ElevenLabs, Vercel          |

GPT Astra Max stays in reserve for the live page's visual layer. P4 writes a handoff packet in Phase 3 (docs/ui-handoff.md) with the component tree, props, event contract, and a replay fixture, so Astra Max produces drop-in components without touching server code. A human pastes the packet into Astra Max and brings the result back to P4's Claude Code for integration on a branch.

## Phase timeline

The full flow runs end to end by hour 15.

| Phase   | Hours    | Focus                       |
| ------- | -------- | --------------------------- |
| Phase 0 | 0 to 2   | Accounts, repo, spikes      |
| Phase 1 | 2 to 6   | Data, engine, real adapters |
| Phase 2 | 6 to 10  | Solver, detection           |
| Phase 3 | 10 to 15 | Deadlock, calls, page       |
| Phase 4 | 15 to 19 | Edge cases, safety, speed   |
| Phase 5 | 19 to 24 | Demo reset, rehearsals      |

Checkpoint A (hour 9): "dinner today?" produces the poll bundle within 5 seconds and the solver logs a winner.
Checkpoint B (hour 15): a real call ends in "Booked."
Checkpoint C (hour 19): edge cases and safety pass.
Final (hour 23): five rehearsals done, backups recorded.

## Accounts, links, and secrets

One person creates each account, then shares the secrets with the team through a private channel (a password manager share or a direct message), never through Git and never inside a TEAM MESSAGE block. Every Claude Code reads secrets from a local .env file at the repo root, and the repo commits only .env.example with variable names.

| Service      | Owner     | Link                               | Produces                                                                           |
| ------------ | --------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| GitHub       | P1 Aditya | https://github.com/new             | Private repo, teammates invited, main protected                                    |
| Railway      | P1 Aditya | https://railway.com                | Always-on server, volume for SQLite, public URL                                    |
| Photon       | P2 Pranav | https://app.photon.codes/dashboard | Spectrum project, iMessage line, project ID and secret (promo code HACKWITHPHOTON) |
| Anthropic    | P3 Soham  | https://console.anthropic.com      | One team API key for Haiku and Sonnet                                              |
| Google Cloud | P3 Soham  | https://console.cloud.google.com   | OAuth client for Calendar free/busy                                                |
| ElevenLabs   | P4 Mahil  | https://elevenlabs.io/app          | API key, caller agent, SIP trunk to Spectrum                                       |
| Vercel       | P4 Mahil  | https://vercel.com/signup          | Live page hosting                                                                  |

Line lock rule: only one running process connects to the real iMessage line at any moment, or messages get answered twice. Local development uses Spectrum's terminal provider. Whoever needs the real line posts a LINE LOCK team message first and a LINE RELEASE message after. From Checkpoint B onward, only the Railway server holds the line.
