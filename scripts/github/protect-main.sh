#!/usr/bin/env bash
# Protect main on the Bubbleworks repo: PR required, one approval, CI green, no force pushes.
# enforce_admins stays off so the merge captain (Aditya) can land an unblocked PR when nobody
# else is free to approve. Run: bash scripts/github/protect-main.sh
set -euo pipefail

REPO="${REPO:-aditya-karthikeyan/Bubble}"

gh api -X PUT "repos/${REPO}/branches/main/protection" --input - <<'EOF' >/dev/null
{
  "required_status_checks": { "strict": true, "contexts": ["ci"] },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false
}
EOF

gh api "repos/${REPO}/branches/main/protection" \
  --jq '"main protected: approvals=\(.required_pull_request_reviews.required_approving_review_count) checks=\(.required_status_checks.contexts) force_push=\(.allow_force_pushes.enabled) enforce_admins=\(.enforce_admins.enabled)"'
