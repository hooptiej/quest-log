#!/bin/bash
# PostToolUse hook (Bash matcher): reminds Claude to check quest-log whenever
# a Bash command looks like a real completion/deploy event.
#
# Purely additive to the QuestTracker skill's own proactive-sync instructions
# -- doesn't replace them, backstops them, since a skill's trigger is soft
# (relevance-matched) and this is deterministic. Supersedes the echo-based
# one-liner version of this same idea documented in questtracker-skill.md's
# "Automated checkpoint reminders" section (that version was explicitly
# marked "not portable via this repo" -- a real committed script here, wired
# up through .claude/settings.json the same way quest-log-reminder.mjs
# already is, fixes that).
#
# To add/remove trigger patterns, edit the regex below -- one alternative
# per line for readability, no JSON escaping involved. This is a plain
# substring match against the full command text, so it can false-positive
# on a command that merely *mentions* one of these phrases (e.g. inside an
# echo or comment) -- harmless here since the hook only ever adds a
# reminder, never blocks anything.

TRIGGER_PATTERN='git (commit|push)'
TRIGGER_PATTERN="$TRIGGER_PATTERN|gh pr (merge|create)"
TRIGGER_PATTERN="$TRIGGER_PATTERN|gh issue (create|close|comment)"
TRIGGER_PATTERN="$TRIGGER_PATTERN|docker (build|run|restart|compose)"

REMINDER='Quest-log check-in: does this completion belong in the quest log (mcp__quest-log__* tools)? Add, update, or close a quest now if so.'

cmd="$(jq -r '.tool_input.command // empty' 2>/dev/null)"

if printf '%s' "$cmd" | grep -qE "$TRIGGER_PATTERN"; then
  jq -n --arg ctx "$REMINDER" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
fi
