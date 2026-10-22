#!/usr/bin/env bash
# Connect Claude Code to SAWk and schedule the nightly run (macOS).
#
#   scripts/install-claude.sh [--dry-run] [--uninstall] [--no-launchd] [--no-nightly]
#                             [--store-token-in-config]
#
# What it does, in order:
#   1. stores your SAWk token in the macOS Keychain (service sawk, account token)
#   2. registers the MCP server `sawk` for your user in Claude Code (token read from Keychain at
#      connect time by a 3-line helper, so ~/.claude.json holds no secret)
#   3. links skills/sawk into ~/.claude/skills/sawk
#   4. installs the nightly launchd job (05:15 local) that runs scripts/run-nightly.sh
#
# Needs: SAWK_TOKEN (create it in the web app, Agents screen; or type it when asked) and
#        SAWK_URL (default: SUPABASE_URL from .env + /functions/v1/sawk).
# Safe to re-run. --uninstall removes everything this script added, including the Keychain item.
set -euo pipefail

DRY=0; UNINSTALL=0; LAUNCHD=1; NIGHTLY=1; TOKEN_IN_CONFIG=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --no-launchd) LAUNCHD=0 ;;
    --no-nightly) NIGHTLY=0 ;;
    --store-token-in-config) TOKEN_IN_CONFIG=1 ;;
    -h | --help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 64 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.zaitsew.sawk.nightly"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SKILL_LINK="$HOME/.claude/skills/sawk"
HELPER="$HOME/.config/sawk/mcp-headers.sh"
LOG="$HOME/Library/Logs/sawk-nightly.log"

say() { printf '==> %s\n' "$*"; }
# run: print the command (never one carrying a secret) and execute it unless --dry-run.
run() { printf '    + %s\n' "$*"; [ "$DRY" = 1 ] || "$@"; }

[ "$(uname -s)" = Darwin ] || { echo "This installer is for macOS (Keychain, launchd)." >&2; exit 1; }
[ "$DRY" = 1 ] && say "dry run: nothing will be changed"

# ------------------------------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  say "Claude Code: remove MCP server sawk (user scope)"
  if command -v claude >/dev/null 2>&1; then run claude mcp remove sawk --scope user || true
  else echo "    claude not found; skipped"; fi

  say "Skill link"
  if [ -L "$SKILL_LINK" ]; then run rm "$SKILL_LINK"
  elif [ -e "$SKILL_LINK" ]; then echo "    $SKILL_LINK is not a symlink; left alone"
  else echo "    none"; fi

  say "launchd job"
  if [ "$LAUNCHD" = 1 ]; then
    run launchctl bootout "gui/$(id -u)/$LABEL" || true
  fi
  [ -f "$PLIST" ] && run rm "$PLIST" || echo "    no $PLIST"

  say "Helper and Keychain item"
  [ -f "$HELPER" ] && run rm "$HELPER" || echo "    no helper"
  run security delete-generic-password -s sawk -a token || echo "    no Keychain item"
  say "done. The log $LOG is kept. Revoke the token in the web app (Agents screen) if you will not reuse it."
  exit 0
fi

# ------------------------------------------------------------------------------------------------
command -v claude >/dev/null 2>&1 || { echo "claude (Claude Code) not found on PATH" >&2; exit 1; }

# URL: SAWK_URL, else SUPABASE_URL from .env (read, not sourced) + /functions/v1/sawk.
if [ -z "${SAWK_URL:-}" ]; then
  supabase_url="${SUPABASE_URL:-}"
  if [ -z "$supabase_url" ] && [ -f "$REPO/.env" ]; then
    supabase_url="$(sed -n 's/^SUPABASE_URL=//p' "$REPO/.env" | head -n1 | tr -d '"'"'"' \r')"
  fi
  [ -n "$supabase_url" ] || { echo "Set SAWK_URL (e.g. https://<ref>.supabase.co/functions/v1/sawk) or SUPABASE_URL in .env" >&2; exit 1; }
  SAWK_URL="${supabase_url%/}/functions/v1/sawk"
fi
SAWK_URL="${SAWK_URL%/}"; SAWK_URL="${SAWK_URL%/mcp}"
case "$SAWK_URL" in https://*|http://localhost*|http://127.0.0.1*) ;; *) echo "SAWK_URL must be https:// (got $SAWK_URL)" >&2; exit 1 ;; esac
case "$SAWK_URL" in *[\"\ \\]*) echo "SAWK_URL has characters that need escaping" >&2; exit 1 ;; esac
MCP_URL="$SAWK_URL/mcp"
say "SAWk server: $MCP_URL"

# ------------------------------------------------------------------------------------------------
say "1/4 Token -> macOS Keychain (service sawk, account token)"
TOKEN="${SAWK_TOKEN:-}"
if [ -n "$TOKEN" ]; then echo "    using SAWK_TOKEN from the environment"
elif security find-generic-password -s sawk -a token >/dev/null 2>&1; then
  echo "    a token is already in Keychain; keeping it (re-run with SAWK_TOKEN=... to replace)"
elif [ "$DRY" = 1 ]; then echo "    would ask for the token (input hidden)"
elif [ -t 0 ]; then
  printf '    Paste your SAWk token (web app > Agents; input hidden): '
  read -rs TOKEN; echo
else
  echo "No token. Set SAWK_TOKEN or run this in a terminal." >&2; exit 1
fi
if [ -n "$TOKEN" ]; then
  case "$TOKEN" in *[!A-Za-z0-9_.~+/=-]*|"") echo "The token has unexpected characters; paste only the token." >&2; exit 1 ;; esac
  if [ "$DRY" = 1 ]; then echo "    + security add-generic-password -s sawk -a token -U   (token via stdin)"
  else
    # `security -i` reads the command from stdin, so the token never appears in the process list.
    printf 'add-generic-password -s sawk -a token -U -w %s\n' "$TOKEN" | security -i >/dev/null
    echo "    stored"
  fi
  # A quick check; a server that is not deployed yet is a warning, not a failure.
  if [ "$DRY" != 1 ] && command -v curl >/dev/null 2>&1; then
    code="$(printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -sS -o /dev/null -w '%{http_code}' -H @- "$SAWK_URL/api/context?days=1" 2>/dev/null || true)"
    case "$code" in
      200) echo "    token accepted by the server" ;;
      401 | 403) echo "    WARNING: the server rejected the token (HTTP $code). Create a new one in the web app." ;;
      *) echo "    note: could not verify the token (HTTP ${code:-none}); is the function deployed?" ;;
    esac
  fi
fi

# ------------------------------------------------------------------------------------------------
say "2/4 Claude Code MCP server (user scope)"
if [ "$TOKEN_IN_CONFIG" = 1 ]; then
  [ -n "$TOKEN" ] || TOKEN="$(security find-generic-password -s sawk -a token -w 2>/dev/null || true)"
  echo "    --store-token-in-config: the token will be written to ~/.claude.json"
  run claude mcp remove sawk --scope user >/dev/null 2>&1 || true
  if [ "$DRY" = 1 ]; then
    echo "    + claude mcp add --transport http --scope user sawk $MCP_URL --header 'Authorization: Bearer <token>'"
  else
    claude mcp add --transport http --scope user sawk "$MCP_URL" --header "Authorization: Bearer $TOKEN"
  fi
else
  # The helper prints the Authorization header from Keychain each time Claude Code connects.
  # (headersHelper: https://code.claude.com/docs/en/mcp)
  echo "    helper: $HELPER (reads Keychain; contains no secret)"
  if [ "$DRY" != 1 ]; then
    mkdir -p "$(dirname "$HELPER")"
    cat > "$HELPER" <<'HELPER_EOF'
#!/usr/bin/env bash
# Prints the SAWk MCP auth header as JSON. Written by scripts/install-claude.sh.
set -euo pipefail
t="${SAWK_TOKEN:-$(security find-generic-password -s sawk -a token -w)}"
printf '{"Authorization":"Bearer %s"}\n' "$t"
HELPER_EOF
    chmod 700 "$HELPER"
  fi
  json="{\"type\":\"http\",\"url\":\"$MCP_URL\",\"headersHelper\":\"$HELPER\"}"
  run claude mcp remove sawk --scope user >/dev/null 2>&1 || true
  run claude mcp add-json --scope user sawk "$json"
fi

# ------------------------------------------------------------------------------------------------
say "3/4 Skill: $SKILL_LINK -> $REPO/skills/sawk"
if [ -e "$SKILL_LINK" ] && [ ! -L "$SKILL_LINK" ]; then
  echo "    $SKILL_LINK exists and is not a symlink; leaving it. Remove it and re-run." >&2
else
  run mkdir -p "$HOME/.claude/skills"
  run ln -sfn "$REPO/skills/sawk" "$SKILL_LINK"
fi

# ------------------------------------------------------------------------------------------------
say "4/4 Nightly run (05:15 local, launchd $LABEL)"
if [ "$NIGHTLY" = 0 ]; then echo "    skipped (--no-nightly)"
else
  rendered="$(sed -e "s|__RUN_SCRIPT__|$REPO/scripts/run-nightly.sh|g" \
                  -e "s|__HOME__|$HOME|g" \
                  -e "s|__AGENT__|claude-code|g" \
                  "$REPO/scripts/launchd/$LABEL.plist.template")"
  if [ "$DRY" = 1 ]; then
    echo "    + write $PLIST:"; printf '%s\n' "$rendered" | sed 's/^/        /'
  else
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    printf '%s\n' "$rendered" > "$PLIST"
    plutil -lint "$PLIST" >/dev/null
  fi
  if [ "$LAUNCHD" = 1 ]; then
    run launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    run launchctl bootstrap "gui/$(id -u)" "$PLIST"
  else
    echo "    --no-launchd: plist written, job not loaded"
  fi
  echo "    log: $LOG"
fi

cat <<NEXT

Done$( [ "$DRY" = 1 ] && echo " (dry run)").
  Try it now:   claude -p "Use the sawk skill in Ask mode: what's on tonight?" --allowedTools "mcp__sawk__*"
  First run:    $REPO/scripts/run-nightly.sh
  Did it run?   web app > Agents, or: curl -H "Authorization: Bearer \$(security find-generic-password -s sawk -a token -w)" $SAWK_URL/api/runs
  Remove:       $REPO/scripts/install-claude.sh --uninstall
NEXT
