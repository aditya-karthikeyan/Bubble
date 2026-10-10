# apps/server image for Railway. Built from the repo root so the workspace resolves.
FROM node:22-slim

# better-sqlite3 compiles from source when no prebuilt binary matches, so node-gyp needs these.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.33.0

WORKDIR /app

# Install with only the manifests first so the layer caches across code changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
# pnpm patchedDependencies (spectrum-ts poll-vote fix) must be present at install time.
COPY patches patches
RUN pnpm install --frozen-lockfile --filter @bubbleworks/server...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY data/venues.json data/venues.json

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
ENV DATABASE_PATH=/data/bubbleworks.db
EXPOSE 3001

CMD ["pnpm", "--filter", "@bubbleworks/server", "start"]
