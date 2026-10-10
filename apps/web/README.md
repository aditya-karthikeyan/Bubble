# apps/web

Next.js live page on Vercel, owned by P4 (Mahil). P4 creates the app here in Phase 0/1.

Live page: `/p/[token]`. Connects to the server Socket.io namespace `/live` (see docs/CONTRACTS.md).
Add `transpilePackages: ["@bubbleworks/shared"]` to next.config so the shared TypeScript source compiles.
