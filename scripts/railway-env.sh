#!/bin/sh
# Push named variables from the local .env to the Railway server service without printing them.
# Usage: scripts/railway-env.sh ANTHROPIC_API_KEY GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET ...
# Skips names that are empty or missing in .env. Add --deploy to let Railway redeploy right away.
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] || { echo ".env not found at repo root" >&2; exit 1; }
DEPLOY=--skip-deploys
ARGS=""
for name in "$@"; do
  if [ "$name" = "--deploy" ]; then DEPLOY=""; continue; fi
  value=$(grep -E "^${name}=" .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
  if [ -z "$value" ]; then echo "skip $name (empty or missing in .env)"; continue; fi
  ARGS="$ARGS --set ${name}=${value}"
  echo "set $name (${#value} chars)"
done
[ -n "$ARGS" ] || { echo "nothing to set"; exit 0; }
# shellcheck disable=SC2086
railway variables --service server $ARGS $DEPLOY >/dev/null 2>&1 && echo "pushed to Railway" || { echo "railway variables failed" >&2; exit 1; }
