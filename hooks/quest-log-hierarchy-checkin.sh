#!/bin/bash
# PostToolUse hook (mcp__*__add_idea matcher): nudges Claude to actively
# decide on a parent when creating a Mission/Task, rather than leaving it
# top-level by default. Prompted by a real cleanup (#108) where several
# add_idea-created items sat orphaned (parentId: null) with no deliberate
# reason -- caught only because they'd separately been attention-flagged.
#
# Quests are legitimately top-level by design (see e.g. the "homeserver-docker"
# quest's own notes on why umbrella intents stay their own top-level Quest
# rather than a literal parent) -- this hook only fires for level
# mission/task (mission is add_idea's own default when level is omitted).
# A missing parentIdOrTitle on one of those is usually a skipped placement
# decision, not a deliberate one, so this nudges rather than blocks.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
input="$(cat)"
ql_require quest-log-hierarchy-checkin PostToolUse "$input" jq

tool_name="$(printf '%s' "$input" | jq -r '.tool_name // empty')"
printf '%s' "$tool_name" | grep -qE 'mcp__.*__add_idea$' || exit 0

level="$(printf '%s' "$input" | jq -r '.tool_input.level // "mission"')"
parent="$(printf '%s' "$input" | jq -r '.tool_input.parentIdOrTitle // empty')"

if [ "$level" != "quest" ] && [ -z "$parent" ]; then
  ql_emit PostToolUse 'Quest-log check-in: this new item has no parent. Is there an existing Quest/Mission it actually belongs under? If so, pass parentIdOrTitle next time or move/recruit it now -- if it is genuinely standalone, no action needed.'
fi
exit 0
