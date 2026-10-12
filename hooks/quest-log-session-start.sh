#!/bin/bash
# SessionStart hook (#142): one message per session, in this order:
#   1. preflight: name any tool the hooks need that this machine lacks;
#   2. version check: compare this plugin's version with the hooksVersion
#      the quest-log server reports on /health: give the exact update
#      commands when this machine is behind, say prod needs a deploy when
#      it's ahead (#144), or say the server couldn't be reached.
#      The same response seeds this session's auto-log / Pro Mode cache
#      (#143, ql_flags in lib.sh), so the first prompt asks nothing;
#   3. the standing nudges: surface attention-flagged items, then review
#      stale "idea" items (nothing about the write-triggered hooks
#      re-surfaces old unread state on its own).
# Deliberately jq-free (sed + printf), so it still speaks when jq is the
# missing tool.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
QL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
input="$(cat)"
QUEST_LOG_URL="${QUEST_LOG_URL:-http://questlog.local/api/state}"
UPDATE_CMD='claude plugin marketplace update quest-log, then claude plugin update quest-log@quest-log, then restart Claude Code'
parts=()

# 1. preflight
missing=()
for t in jq curl; do ql_has "$t" || missing+=("$t"); done
if [ ${#missing[@]} -gt 0 ]; then
  ql_mark_reported "$input"
  parts+=("quest-log hooks: missing ${missing[*]} on this machine, so some quest-log check-ins can't run. Install them.")
fi

# 2. version check
mine="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$QL_ROOT/.claude-plugin/plugin.json" | head -n 1)"
if ql_has curl; then
  health_url="${QUEST_LOG_URL%%/api/*}/health"
  # -f: an HTTP error (a proxy's 502 page, say) counts as unreachable (#144).
  # -4: macOS waits ~5s for an IPv6 answer avahi-publish never sends for .local (#151).
  health="$(curl -4 -fs -m 1.5 "$health_url" 2>/dev/null)"
  ql_flags_write_from_health "$health" "$input"
  theirs="$(printf '%s' "$health" | sed -n 's/.*"hooksVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  if [ -z "$health" ]; then
    parts+=("quest-log hooks: couldn't reach quest-log at $health_url to check for hook updates (offline or off the home LAN?).")
  elif [ -n "$theirs" ] && [ "$theirs" != "$mine" ]; then
    # Which way round (#144): a machine ahead of prod has nothing to update.
    case "$(ql_version_cmp "$mine" "$theirs")" in
      -1) parts+=("quest-log hooks on this machine are v$mine, older than the server's v$theirs. Update now: $UPDATE_CMD.") ;;
      1) parts+=("quest-log hooks on this machine are v$mine, newer than the server's v$theirs: prod hasn't been redeployed yet. Nothing to do on this machine; deploy quest-log to finish.") ;;
      *) parts+=("quest-log hooks on this machine are v$mine, which differs from the server's v$theirs. Update now: $UPDATE_CMD.") ;;
    esac
  fi
fi

# 3. standing nudges
parts+=("Session started: early check -- call mcp__quest-log__list_quests(attention: true) and surface attention-flagged items to the user first; then review quest-log for items with status: idea that have not been touched recently and surface stale ones before this session progresses, especially if it touches quest-log-adjacent work (issues, PRs, memory, etc.).")

ql_emit SessionStart "$(printf '%s\n' "${parts[@]}")"
exit 0
