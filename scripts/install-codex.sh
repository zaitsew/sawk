#!/usr/bin/env bash
# Connect Codex (CLI, IDE extension and desktop app share one config) to SAWk.
#
#   scripts/install-codex.sh [--dry-run] [--uninstall] [--nightly] [--no-skill]
#
# What it does:
#   1. `codex mcp add sawk --url <SAWK_URL>/mcp` and a `http_headers_helper` line in
#      ~/.codex/config.toml that reads your token from the macOS Keychain at connect time, so the
#      config holds no secret and the Codex app works without an environment variable.
#   2. links skills/sawk into ~/.agents/skills/sawk (Codex's user skills directory)
#   3. --nightly: installs the 05:15 launchd job running `codex exec` (off by default; one nightly
#      job is enough, and this replaces the Claude Code one if it is installed)
#
# Token: run scripts/install-claude.sh first, or pass SAWK_TOKEN=... (stored in Keychain).
# URL:   SAWK_URL, else SUPABASE_URL from .env + /functions/v1/sawk.
set -euo pipefail

DRY=0; UNINSTALL=0; NIGHTLY=0; SKILL=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --nightly) NIGHTLY=1 ;;
    --no-skill) SKILL=0 ;;
    -h | --help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 64 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
CONFIG="$CODEX_DIR/config.toml"
LABEL="com.zaitsew.sawk.nightly"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SKILL_LINK="$HOME/.agents/skills/sawk"
HELPER="$HOME/.config/sawk/mcp-headers.sh"

say() { printf '==> %s\n' "$*"; }
run() { printf '    + %s\n' "$*"; [ "$DRY" = 1 ] || "$@"; }

[ "$(uname -s)" = Darwin ] || { echo "This installer is for macOS (Keychain, launchd)." >&2; exit 1; }
command -v codex >/dev/null 2>&1 || { echo "codex not found on PATH" >&2; exit 1; }
[ "$DRY" = 1 ] && say "dry run: nothing will be changed"

# ------------------------------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  say "Codex: remove MCP server sawk"
  run codex mcp remove sawk || true
  say "Skill link"
  if [ -L "$SKILL_LINK" ]; then run rm "$SKILL_LINK"
  elif [ -e "$SKILL_LINK" ]; then echo "    $SKILL_LINK is not a symlink; left alone"
  else echo "    none"; fi
  say "launchd job (only if it runs Codex)"
  if [ -f "$PLIST" ] && grep -q '<string>codex</string>' "$PLIST"; then
    run launchctl bootout "gui/$(id -u)/$LABEL" || true
    run rm "$PLIST"
  else echo "    none"; fi
  say "done. The token (Keychain) and helper are shared with Claude Code; scripts/install-claude.sh --uninstall removes them."
  exit 0
fi

# ------------------------------------------------------------------------------------------------
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
say "1/3 Token and Codex MCP server"
TOKEN="${SAWK_TOKEN:-}"
if [ -n "$TOKEN" ]; then
  case "$TOKEN" in *[!A-Za-z0-9_.~+/=-]*) echo "The token has unexpected characters." >&2; exit 1 ;; esac
  if [ "$DRY" = 1 ]; then echo "    + store SAWK_TOKEN in Keychain (service sawk, account token)"
  else printf 'add-generic-password -s sawk -a token -U -w %s\n' "$TOKEN" | security -i >/dev/null; fi
elif security find-generic-password -s sawk -a token >/dev/null 2>&1; then
  echo "    token found in Keychain"
elif [ "$DRY" = 1 ]; then echo "    no token yet (a real run needs SAWK_TOKEN or scripts/install-claude.sh first)"
else
  echo "No token in Keychain. Run scripts/install-claude.sh first, or set SAWK_TOKEN." >&2; exit 1
fi

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

run codex mcp remove sawk >/dev/null 2>&1 || true
run codex mcp add sawk --url "$MCP_URL"
echo "    + add http_headers_helper = \"$HELPER\" under [mcp_servers.sawk] in $CONFIG"
if [ "$DRY" != 1 ]; then
  [ -f "$CONFIG" ] || { echo "codex did not create $CONFIG" >&2; exit 1; }
  tmp="$(mktemp)"
  awk -v line="http_headers_helper = \"$HELPER\"" '
    { print }
    $0 == "[mcp_servers.sawk]" { print line; done = 1 }
    END { if (!done) exit 3 }' "$CONFIG" > "$tmp" || { rm -f "$tmp"; echo "[mcp_servers.sawk] not found in $CONFIG" >&2; exit 1; }
  cat "$tmp" > "$CONFIG"; rm -f "$tmp"
  codex mcp get sawk | sed 's/^/    /'
fi

# ------------------------------------------------------------------------------------------------
say "2/3 Skill: $SKILL_LINK -> $REPO/skills/sawk  (Codex's user skills directory is ~/.agents/skills)"
if [ "$SKILL" = 0 ]; then echo "    skipped (--no-skill)"
elif [ -e "$SKILL_LINK" ] && [ ! -L "$SKILL_LINK" ]; then
  echo "    $SKILL_LINK exists and is not a symlink; leaving it." >&2
else
  run mkdir -p "$HOME/.agents/skills"
  run ln -sfn "$REPO/skills/sawk" "$SKILL_LINK"
fi

# ------------------------------------------------------------------------------------------------
say "3/3 Nightly run with codex exec"
if [ "$NIGHTLY" = 0 ]; then echo "    off (add --nightly; the Claude Code job is the recommended one)"
else
  rendered="$(sed -e "s|__RUN_SCRIPT__|$REPO/scripts/run-nightly.sh|g" -e "s|__HOME__|$HOME|g" \
                  -e "s|__AGENT__|codex|g" "$REPO/scripts/launchd/$LABEL.plist.template")"
  if [ "$DRY" = 1 ]; then echo "    + write $PLIST (SAWK_AGENT=codex)"
  else
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    printf '%s\n' "$rendered" > "$PLIST"; plutil -lint "$PLIST" >/dev/null
  fi
  run launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  run launchctl bootstrap "gui/$(id -u)" "$PLIST"
fi

cat <<NEXT

Done$( [ "$DRY" = 1 ] && echo " (dry run)").
  Try it:   codex exec --skip-git-repo-check "Use the sawk skill in Ask mode: what's on tonight?"
  Remove:   $REPO/scripts/install-codex.sh --uninstall
NEXT
