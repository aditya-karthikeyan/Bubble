# Bubbleworks

Bubble agents that plan dinner inside a friend group's iMessage chat. Built for HackNC 2026.

Each member has a private bubble agent that knows their diet, allergies, budget, neighborhood,
calendar, location, and Focus state. "dinner tonight?" makes the bubbles deliberate: they pick a
venue every member can use, call the restaurant to book it, and post "Booked". Helper agents send
calendar invites, split the bill after dinner, and ask the restaurant to hold the table when
someone runs late. A live page shows the bubbles drift, merge, and split into helpers.

## Layout

```
apps/server     Fastify + Socket.io server: iMessage (Photon Spectrum), plan engine, solver,
                timers, caller (ElevenLabs + Twilio), helper agents, SQLite via Drizzle (Railway)
apps/web        Next.js site: landing, live plan page at /p/[token], tickets, link previews (Vercel)
packages/shared zod schemas, event contract, port interfaces, fakes, constants
data/           seed venues
```

## Setup

```sh
git clone https://github.com/aditya-karthikeyan/Bubble.git bubbleworks
cd bubbleworks
pnpm install
cp .env.example .env     # fill in the keys you need
pnpm typecheck && pnpm lint && pnpm test
pnpm dev:server          # http://localhost:3001/health
pnpm --filter @bubbleworks/web dev   # http://localhost:3000, live demo at /p/demo?replay=basic
```

Requires Node 22+ and pnpm 10 (`npm i -g pnpm@10`). Without any keys the server runs with a local
terminal messaging provider and a fake caller.

## Scripts

| Command            | What it does                                                  |
| ------------------ | ------------------------------------------------------------- |
| `pnpm dev:server`  | server with reload on :3001                                   |
| `pnpm test`        | vitest across the workspace                                   |
| `pnpm typecheck`   | TypeScript in every package                                   |
| `pnpm lint`        | ESLint                                                        |
| `pnpm format`      | Prettier                                                      |
| `pnpm sim`         | a scripted plan against the engine, printing page events      |
| `pnpm db:seed`     | seed demo people and venues                                   |
| `pnpm demo:reset`  | clear plans for a fresh demo, keeping people and venues       |
| `pnpm p4:agent`    | create or update the ElevenLabs caller agent                  |
| `pnpm p4:testcall` | place one test call through the caller agent                  |
| `pnpm p3:smoke`    | check a deployed server: health, calendar connect, .ics, keys |

Secrets live in `.env` (gitignored); `.env.example` lists every variable.
