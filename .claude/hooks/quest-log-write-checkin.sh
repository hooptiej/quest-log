#!/bin/bash
# PostToolUse hook (Write|Edit matcher): reminds Claude to check quest-log
# after a CLAUDE.md or memory-file write -- these often capture scope/
# blocker/decision changes that quest-log-checkin.sh's Bash-only matcher can
# never see (writing a file isn't a Bash command). Companion to that script;
# same purpose, different trigger surface. Supersedes the doc-only
# echo-based version of this idea in questtracker-skill.md's "Automated
# checkpoint reminders" section.

path="$(jq -r '.tool_input.file_path // empty' 2>/dev/null)"

if printf '%s' "$path" | grep -qiE '(^|/)CLAUDE\.md$|memory'; then
  jq -n --arg ctx 'Quest-log check-in: this file often documents scope, blockers, or decisions -- consider whether quest-log should reflect this change.' \
    '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
fi
