#!/bin/bash
# PostToolUse hook (Write|Edit matcher): reminds Claude to check quest-log
# after a CLAUDE.md or memory-file write -- these often capture scope/
# blocker/decision changes that quest-log-checkin.sh's Bash-only matcher can
# never see (writing a file isn't a Bash command). Companion to that script;
# same purpose, different trigger surface. Supersedes the doc-only
# echo-based version of this idea in skills/quest-tracker/SKILL.md's "Automated
# checkpoint reminders" section.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
input="$(cat)"
ql_require quest-log-write-checkin PostToolUse "$input" jq

path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"

if printf '%s' "$path" | grep -qiE '(^|/)CLAUDE\.md$|memory'; then
  ql_emit PostToolUse 'Quest-log check-in: this file often documents scope, blockers, or decisions -- consider whether quest-log should reflect this change.'
fi
exit 0
