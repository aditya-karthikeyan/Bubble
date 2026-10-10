#!/usr/bin/env bash
# Invite teammates as collaborators with push access.
# Run: bash scripts/github/invite.sh pranav-handle soham-handle mahil-handle
set -euo pipefail

REPO="${REPO:-aditya-karthikeyan/Bubble}"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <github-username> [...]" >&2
  exit 1
fi

for user in "$@"; do
  gh api -X PUT "repos/${REPO}/collaborators/${user}" -f permission=push >/dev/null \
    && echo "invited ${user}" \
    || echo "FAILED ${user}" >&2
done
