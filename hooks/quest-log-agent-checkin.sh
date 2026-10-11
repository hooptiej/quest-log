#!/bin/bash
# PostToolUse hook (Agent tool matcher): tracks background-agent dispatches
# per session and escalates the quest-log check-in nudge once a session has
# spun up multiple agents. This is a better proxy for "this turned into a
# real investigation" than any single tool family (e.g. the Halo hook) --
# a multi-source dig can lean entirely on other tools and never touch a
# Halo ticket tool at all, so counting Agent dispatches catches what a
# tool-family-scoped hook structurally can't.
#
# State is a per-session counter file under $TMPDIR (falls back to /tmp),
# keyed by session_id so concurrent sessions don't share a count. These
# files are small and left for the OS's normal tmp cleanup -- not pruned
# here, same tradeoff the other hooks in this set accept for their own
# state.

input="$(cat)"
session_id="$(printf '%s' "$input" | jq -r '.session_id // empty')"
tool_name="$(printf '%s' "$input" | jq -r '.tool_name // empty')"

[ "$tool_name" = "Agent" ] || exit 0
[ -n "$session_id" ] || exit 0

state_dir="${TMPDIR:-/tmp}/quest-log-agent-checkin"
mkdir -p "$state_dir" 2>/dev/null || exit 0
count_file="$state_dir/$session_id"

count=0
[ -f "$count_file" ] && count="$(cat "$count_file" 2>/dev/null)"
case "$count" in ''|*[!0-9]*) count=0 ;; esac
count=$((count + 1))
printf '%s' "$count" > "$count_file" 2>/dev/null

if [ "$count" -ge 2 ]; then
  jq -n --arg ctx "Quest-log check-in: this session has dispatched $count background agents now -- that usually means a real multi-source investigation, not a quick lookup. Is this tracked in quest-log yet (add_idea/set_quest_status), or just sitting in conversation?" \
    '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
fi
