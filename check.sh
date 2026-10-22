#!/usr/bin/env bash
# The gate and the first-run check. Runs every test (Deno on PGlite, no Docker;
# the web build when web/ exists) and lists what is still missing to deploy.
#
#   ./check.sh          tests + what is missing
#   ./check.sh usage    real-usage counters (key=value), read by `teyla products`
set -uo pipefail
cd "$(dirname "$0")"

[ -f .env ] && { set -a; source .env; set +a; }

case "${1:-}" in
  usage)
    if [ -z "${SAWK_PROBE_REF:-}" ] || ! command -v teyla >/dev/null 2>&1; then
      echo "usage_probe=not_configured"; exit 0
    fi
    teyla probe-sql "$SAWK_PROBE_REF" "select
      (select count(*) from sawk.events where starts_at > now()) as upcoming_events,
      (select count(*) from sawk.feed) as feed_items,
      (select count(*) from sawk.feedback where at > now() - interval '7 days') as feedback_7d,
      (select count(*) from sawk.runs where started_at > now() - interval '7 days' and agent <> 'ingest') as agent_runs_7d,
      (select count(distinct user_id) from sawk.feedback where at > now() - interval '7 days') as active_users_7d"
    exit 0 ;;
esac

missing=()
command -v deno >/dev/null 2>&1 || missing+=("toolchain: deno (https://deno.com)")
[ -d web ] && [ -f web/package.json ] && { command -v npm >/dev/null 2>&1 || missing+=("toolchain: npm (web/)"); }
if [ "${#missing[@]}" -gt 0 ]; then
  echo "MISSING:"; for m in "${missing[@]}"; do echo "  - $m"; done; exit 1
fi

deno task test || { echo "deno test FAILED"; exit 1; }

if [ -f web/package.json ]; then
  ( cd web && { [ -d node_modules ] || npm ci --silent; } && npm run -s check && npm run -s test && npm run -s build ) \
    || { echo "web FAILED"; exit 1; }
fi

# --- what a deploy still needs (not a failure: tests do not need it) -----------
todo=()
[ -n "${SUPABASE_URL:-}" ] || todo+=("SUPABASE_URL (see .env.example)")
[ -n "${DATABASE_URL:-}${SUPABASE_PROJECT_REF:-}" ] || todo+=("DATABASE_URL or SUPABASE_PROJECT_REF (see .env.example)")
command -v supabase >/dev/null 2>&1 || todo+=("supabase CLI, to deploy the functions")
if [ "${#todo[@]}" -gt 0 ]; then
  echo "To deploy, still set:"; for t in "${todo[@]}"; do echo "  - $t"; done
fi
echo "OK"
