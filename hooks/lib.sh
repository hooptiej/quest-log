# quest-log plugin: helpers sourced by every hooks/*.sh script (#142).
#
# A hook must never block a tool call, so every script exits 0. What this
# adds over the old `2>/dev/null || true` is that a hook that CAN'T run
# (a tool missing on this machine) says so once per session instead of
# vanishing. ql_emit needs no jq, so the "can't run" message works even
# when jq is the missing piece.

QL_STATE_DIR="${TMPDIR:-/tmp}/quest-log-hooks"

ql_json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/}
  s=${s//$'\n'/\\n}
  printf '%s' "$s"
}

# ql_emit EVENT TEXT: print the hookSpecificOutput JSON Claude Code reads.
ql_emit() {
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' \
    "$1" "$(ql_json_escape "$2")"
}

# ql_session_id JSON: the session_id field, without needing jq.
ql_session_id() {
  printf '%s' "$1" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# ql_has TOOL: is TOOL on PATH? QL_HIDE_TOOLS (space-separated) lets the
# tests pretend a tool is missing.
ql_has() {
  case " ${QL_HIDE_TOOLS:-} " in *" $1 "*) return 1 ;; esac
  command -v "$1" >/dev/null 2>&1
}

# ql_mark_reported INPUT: remember that this session has been told about
# missing tools. Returns 1 if it had already been told.
ql_mark_reported() {
  local sid mark
  sid="$(ql_session_id "$1")"
  mark="$QL_STATE_DIR/missing-${sid:-nosession}"
  [ -f "$mark" ] && return 1
  mkdir -p "$QL_STATE_DIR" 2>/dev/null && : > "$mark" 2>/dev/null
  return 0
}

# ql_require HOOK EVENT INPUT TOOL...: return if every TOOL exists; else
# say which are missing (once per session) and exit 0.
ql_require() {
  local hook=$1 event=$2 input=$3 t
  shift 3
  local missing=()
  for t in "$@"; do ql_has "$t" || missing+=("$t"); done
  [ ${#missing[@]} -eq 0 ] && return 0
  if ql_mark_reported "$input"; then
    ql_emit "$event" "quest-log hook $hook could not run on this machine: missing ${missing[*]}. Install it so the quest-log check-ins work (needs bash, jq, curl, node)."
  fi
  exit 0
}
