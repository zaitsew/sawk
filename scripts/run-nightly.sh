#!/usr/bin/env bash
# One unattended SAWk run: Claude Code (or Codex) follows skills/sawk in Run mode, on your own
# subscription (no API key). Started by launchd at 05:15; safe to run by hand.
#
#   scripts/run-nightly.sh              run now
#   scripts/run-nightly.sh --dry-run    print what would run, run nothing
#
# Environment (all optional):
#   SAWK_AGENT      claude-code (default) | codex
#   SAWK_MODEL      model for the run (default: sonnet for Claude Code)
#   SAWK_TIMEOUT    seconds before the run is killed (default 2700 = 45 minutes)
#   SAWK_TOKEN      token override; default is the macOS Keychain item service=sawk account=token
#   SAWK_FORCE      set to 1 to skip the machine-load check
set -euo pipefail

DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  -h | --help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "unknown argument: $1" >&2; exit 64 ;;
esac

AGENT="${SAWK_AGENT:-claude-code}"
TIMEOUT="${SAWK_TIMEOUT:-2700}"
STATE_DIR="${SAWK_STATE_DIR:-$HOME/.local/state/sawk}"
log() { printf '%s sawk-nightly: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

# --- pick the command -------------------------------------------------------------------------
PROMPT="Use the sawk skill in Run mode. agent=${AGENT}."
case "$AGENT" in
  claude-code)
    MODEL="${SAWK_MODEL:-sonnet}"
    CMD=(claude -p "$PROMPT" --model "$MODEL"
         --allowedTools "mcp__sawk__*,WebSearch,WebFetch,Skill"
         --max-turns 80 --no-session-persistence)
    ;;
  codex)
    # Reads the MCP server from ~/.codex/config.toml (scripts/install-codex.sh). Nobody can answer an
    # approval prompt at 05:15, so sawk's tools (they write only the person's own feed) are approved
    # for this run only; web search is Codex's own tool.
    CMD=(codex exec --skip-git-repo-check --ephemeral --sandbox read-only
         -c 'web_search="live"' -c 'mcp_servers.sawk.default_tools_approval_mode="approve"')
    [ -n "${SAWK_MODEL:-}" ] && CMD+=(-m "$SAWK_MODEL")
    CMD+=("$PROMPT")
    ;;
  *) log "unknown SAWK_AGENT=$AGENT (claude-code | codex)"; exit 64 ;;
esac

if [ "$DRY" = 1 ]; then
  log "dry run: agent=$AGENT timeout=${TIMEOUT}s cwd=$STATE_DIR"
  log "would check: teyla load --quiet --admit lane (when teyla is installed)"
  log "would read the token from Keychain (service sawk, account token) into SAWK_TOKEN"
  log "would run: ANTHROPIC_API_KEY/OPENAI_API_KEY unset; ${CMD[*]}"
  exit 0
fi

# --- guards -----------------------------------------------------------------------------------
if [ "${SAWK_FORCE:-0}" != 1 ] && command -v teyla >/dev/null 2>&1; then
  if ! teyla load --quiet --admit lane; then
    log "machine is loaded (teyla load refused a lane); skipping tonight's run"
    exit 0
  fi
fi

command -v "${CMD[0]}" >/dev/null 2>&1 || { log "${CMD[0]} not found on PATH ($PATH)"; exit 127; }

# The token: Keychain unless overridden. Never printed, never written to a file.
if [ -z "${SAWK_TOKEN:-}" ]; then
  SAWK_TOKEN="$(security find-generic-password -s sawk -a token -w 2>/dev/null || true)"
fi
if [ -z "$SAWK_TOKEN" ]; then
  log "no SAWk token in Keychain (service sawk, account token). Run scripts/install-claude.sh"
  exit 78
fi
export SAWK_TOKEN

# Subscription, not API billing: an API key in the environment would switch the run to metered use.
unset ANTHROPIC_API_KEY OPENAI_API_KEY
# Codex also keeps a saved login, which may be an API key (`codex login --with-api-key`). That would
# bill every night, so refuse to run unless Codex is signed in with a ChatGPT account.
if [ "$AGENT" = codex ]; then
  login="$(codex login status 2>&1 || true)"
  if ! printf '%s' "$login" | grep -qi 'chatgpt'; then
    log "codex is not signed in with ChatGPT (codex login status: $(printf '%s' "$login" | tail -n1)); refusing a metered run"
    exit 78
  fi
fi

mkdir -p "$STATE_DIR"
cd "$STATE_DIR"

# --- run with a timeout -----------------------------------------------------------------------
if command -v gtimeout >/dev/null 2>&1; then
  RUNNER=(gtimeout --signal=TERM --kill-after=30 "$TIMEOUT")
elif command -v timeout >/dev/null 2>&1; then
  RUNNER=(timeout --signal=TERM --kill-after=30 "$TIMEOUT")
else
  # perl fallback: TERM, then KILL, the child after $TIMEOUT seconds; exit 124 like timeout(1).
  # shellcheck disable=SC2016
  RUNNER=(perl -e 'my $t = shift; my $pid = fork(); die "fork: $!" unless defined $pid;
                   if ($pid == 0) { exec @ARGV or die "exec: $!" }
                   local $SIG{ALRM} = sub { kill "TERM", $pid; sleep 5; kill "KILL", $pid; exit 124 };
                   alarm $t; waitpid($pid, 0); exit(($? & 127) ? 128 + ($? & 127) : $? >> 8)' "$TIMEOUT")
fi

log "start agent=$AGENT timeout=${TIMEOUT}s"
set +e
"${RUNNER[@]}" "${CMD[@]}"
status=$?
set -e
case "$status" in
  0) log "finished ok (exit 0)" ;;
  124) log "killed after ${TIMEOUT}s (timeout); the run row stays 'running' until the next run" ;;
  *) log "failed (exit $status)" ;;
esac
exit "$status"
