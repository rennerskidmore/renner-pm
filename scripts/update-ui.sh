#!/usr/bin/env bash
# Push web/index.html to the live app (stored in pm.app_config, served by pm-app).
# Usage: PM_APP_URL=https://<project>.supabase.co/functions/v1/pm-app/<UI_SECRET> ./scripts/update-ui.sh
set -euo pipefail
: "${PM_APP_URL:?PM_APP_URL env var required}"
cd "$(dirname "$0")/.."
curl -sf -X PUT "$PM_APP_URL/api/ui" \
  -H 'Content-Type: text/html' \
  --data-binary @web/index.html
echo
