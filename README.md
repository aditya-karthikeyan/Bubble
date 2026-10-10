# Bubbleworks

Bubble agents that plan dinner inside a friend group's iMessage chat. Built for HackNC 2026,
Photon track "Agents in iMessage".

Each member has a private bubble agent that knows their diet, allergies, budget, neighborhood,
calendar, location, and Focus state. "dinner today?" makes the bubbles deliberate, ask the group
one poll plus a headcount, pick a venue, call the restaurant, and post "Booked". A live page shows
the bubbles drift, merge, and split into doers.

## Setup

```sh
git clone https://github.com/aditya-karthikeyan/Bubble.git bubbleworks
cd bubbleworks
pnpm install
cp .env.example .env     # fill in only the secrets your role owns
pnpm typecheck && pnpm lint && pnpm test
pnpm dev:server          # http://localhost:3001/health
```

Requires Node 22+ and pnpm 10 (`npm i -g pnpm@10`). `gh` for PRs.

## Layout

```
apps/server     Fastify + Socket.io + plan engine + timers + webhooks (Railway)
apps/web        Next.js live page at /p/[token] (Vercel)
packages/shared zod schemas, event contract, port interfaces, fakes, constants
docs/           CONTRACTS.md, STATUS.md, team-log/<role>.md, roles/, spikes/
```

Start with [docs/CONTRACTS.md](docs/CONTRACTS.md). Modules talk only through the ports in
`packages/shared/src/ports.ts`. Build against the fakes in `@bubbleworks/shared/fakes` until the
real adapter lands.

## Working rules

- One branch per phase: `p2/phase-1-messaging-port`. Never push to main.
- `pnpm typecheck && pnpm lint && pnpm test` green before a PR. Squash merge after one approval.
- Anything under `packages/shared` needs P1's approval.
- Secrets live in `.env` (gitignored) and are shared through a private channel, never Git.
- Only one process holds the real iMessage line. Post LINE LOCK / LINE RELEASE team messages.

## Scripts

| Command           | What it does                                                          |
| ----------------- | --------------------------------------------------------------------- |
| `pnpm dev:server` | server with reload on :3001                                           |
| `pnpm p1:phase0`  | /health + Socket.io round trip against SERVER_PUBLIC_URL or localhost |
| `pnpm test`       | vitest across the workspace                                           |
| `pnpm format`     | prettier                                                              |
