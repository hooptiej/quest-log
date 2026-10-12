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
    ql_emit "$event" "quest-log hook $hook could not run on this machine: missing ${missing[*]}. Install it so the quest-log check-ins work (needs bash, jq, curl)."
  fi
  exit 0
}

# ql_version_cmp A B (#144): print -1, 0 or 1 as version A is older than,
# equal to, or newer than B, comparing each N.N.N component as a number (so
# 1.10.0 > 1.9.0). Prints nothing and returns 1 unless both are plain N.N.N.
# Bash 3.2 safe.
ql_version_cmp() {
  local a b i x y
  for x in "$1" "$2"; do
    printf '%s' "$x" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || return 1
  done
  a=$1 b=$2
  for i in 1 2 3; do
    x=${a%%.*} y=${b%%.*}
    a=${a#*.} b=${b#*.}
    # strip leading zeros so bash doesn't read them as octal
    x=$((10#$x)) y=$((10#$y))
    if [ "$x" -lt "$y" ]; then printf -- '-1'; return 0; fi
    if [ "$x" -gt "$y" ]; then printf '1'; return 0; fi
  done
  printf '0'
}

# --- the auto-log / Pro Mode switches, cached per session (#143) ---
#
# The server's /health carries "autoLog" and "proMode". Rather than ask on
# every prompt, each session keeps them in
# $QL_STATE_DIR/flags-<session_id>, plain key=value lines (read with sed,
# never sourced): fetched_at=<epoch s>, reachable=1|0, auto_log=1|0,
# pro_mode=1|0. The cache lives QL_FLAGS_TTL seconds (default 60), so a
# switch flipped elsewhere reaches every machine within about a minute. An
# unreachable server is cached too (reachable=0), so prompts off the home
# LAN don't each wait for the timeout. Results land in QL_AUTO_LOG and
# QL_PRO_MODE (1/0; 0 when unreachable).

ql_flags_file() {
  local sid
  sid="$(ql_session_id "$1")"
  printf '%s' "$QL_STATE_DIR/flags-${sid:-nosession}"
}

# ql_json_token KEY TEXT: the bare value after "KEY": (true/false/null/a
# number), or nothing if KEY isn't there. The key's opening quote must not
# follow a backslash, so a key quoted inside some string (\"KEY") is skipped.
ql_json_token() {
  printf '%s' "$2" | tr -d '\r\n' | grep -oE '(^|[^\\])"'"$1"'"[[:space:]]*:[[:space:]]*[a-z0-9]*' | head -n 1 \
    | sed 's/.*:[[:space:]]*//'
}

ql_bit() { if [ "$1" = "true" ]; then printf 1; else printf 0; fi; }

# ql_flags_store REACHABLE AUTO_LOG PRO_MODE INPUT: write the cache, set the vars.
ql_flags_store() {
  local file
  QL_AUTO_LOG=$2
  QL_PRO_MODE=$3
  file="$(ql_flags_file "$4")"
  mkdir -p "$QL_STATE_DIR" 2>/dev/null || return 0
  printf 'fetched_at=%s\nreachable=%s\nauto_log=%s\npro_mode=%s\n' "$(date +%s)" "$1" "$2" "$3" \
    > "$file.$$" 2>/dev/null && mv -f "$file.$$" "$file" 2>/dev/null
  return 0
}

# ql_flags_write_from_health BODY INPUT: cache the switches from a /health
# response body (empty = the server couldn't be reached). A server from
# before #143 has no "autoLog" on /health: read them from the full state
# once instead.
ql_flags_write_from_health() {
  local body=$1 input=$2 auto pro state url
  if [ -z "$body" ]; then
    ql_flags_store 0 0 0 "$input"
    return 0
  fi
  auto="$(ql_json_token autoLog "$body")"
  if [ -n "$auto" ]; then
    ql_flags_store 1 "$(ql_bit "$auto")" "$(ql_bit "$(ql_json_token proMode "$body")")" "$input"
    return 0
  fi
  url="${QUEST_LOG_URL:-http://questlog.local/api/state}"
  state="$(curl -4 -fs -m 1.5 "$url" 2>/dev/null | tr -d '\r\n')"
  if [ -z "$state" ]; then
    ql_flags_store 0 0 0 "$input"
    return 0
  fi
  auto="$(printf '%s' "$state" | grep -oE '(^|[^\\])"_autoLog"[[:space:]]*:[[:space:]]*\{[^}]*\}' | head -n 1)"
  auto="$(ql_json_token enabled "$auto")"
  pro="$(ql_json_token _proMode "$state")"
  ql_flags_store 1 "$(ql_bit "$auto")" "$(ql_bit "$pro")" "$input"
}

# ql_flags_get KEY FILE: a 1/0 value from the cache file (0 if absent).
ql_flags_get() {
  local v
  v="$(sed -n "s/^$1=\([01]\)\$/\1/p" "$2" 2>/dev/null | head -n 1)"
  printf '%s' "${v:-0}"
}

# ql_flags INPUT: set QL_AUTO_LOG / QL_PRO_MODE for this session, from the
# cache while it's fresh, else from <origin>/health (rewriting the cache).
ql_flags() {
  local input=$1 file ttl now fetched url
  file="$(ql_flags_file "$input")"
  ttl="${QL_FLAGS_TTL:-60}"
  case "$ttl" in ''|*[!0-9]*) ttl=60 ;; esac
  if [ -r "$file" ]; then
    fetched="$(sed -n 's/^fetched_at=\([0-9][0-9]*\)$/\1/p' "$file" 2>/dev/null | head -n 1)"
    now="$(date +%s)"
    if [ -n "$fetched" ] && [ "$now" -ge "$fetched" ] && [ $((now - fetched)) -lt "$ttl" ]; then
      QL_AUTO_LOG="$(ql_flags_get auto_log "$file")"
      QL_PRO_MODE="$(ql_flags_get pro_mode "$file")"
      return 0
    fi
  fi
  url="${QUEST_LOG_URL:-http://questlog.local/api/state}"
  ql_flags_write_from_health "$(curl -4 -fs -m 1.5 "${url%%/api/*}/health" 2>/dev/null)" "$input"
}
