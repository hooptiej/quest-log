#!/bin/bash
# PostToolUse hook (Halo MCP tool matcher): reminds Claude to log Halo
# ticket work into quest-log. Read-only tools get a lightweight "log a
# view" nudge; mutating tools get a "log a touch, with the real narrative"
# nudge, matching the viewed/touched distinction the ticket-tracking
# feature (log_ticket_view/log_ticket_touch/add_halo_ticket) was built for.
#
# Gated on Pro Mode (state._proMode -- see getProMode/setProMode in
# state.js, toggled via the set_pro_mode MCP tool or the settings-panel
# checkbox) so this is a silent no-op on any deployment that never enables
# Pro Mode, or never has Halo MCP tools present at all -- same gating
# pattern quest-log-reminder.mjs uses for its own state._autoLog.enabled
# check: a plain unauthenticated GET against this server's own /api/state,
# short timeout, fails silent on any network hiccup (offline, off-LAN,
# quest-log down) so a missed reminder never breaks a session. Override the
# target with the QUEST_LOG_URL env var (defaults to
# http://questlog.local/api/state, same default quest-log-reminder.mjs
# uses).

QUEST_LOG_URL="${QUEST_LOG_URL:-http://questlog.local/api/state}"

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
input="$(cat)"
ql_require quest-log-halo-checkin PostToolUse "$input" jq curl

# A network failure here is expected off-LAN and stays quiet; the
# SessionStart hook reports an unreachable server once per session.
pro_mode="$(curl -s -m 1.5 "$QUEST_LOG_URL" 2>/dev/null | jq -r '._proMode // false' 2>/dev/null)"
[ "$pro_mode" = "true" ] || exit 0

tool_name="$(printf '%s' "$input" | jq -r '.tool_name // empty')"

if printf '%s' "$tool_name" | grep -qE 'halopsa_tickets_(get|list|search)'; then
  ql_emit PostToolUse 'Quest-log check-in: you just looked at a Halo ticket. Call mcp__quest-log__log_ticket_view (lightweight, no details needed) to record it.'
elif printf '%s' "$tool_name" | grep -qE 'halopsa_tickets_(add_action|update|create)'; then
  ql_emit PostToolUse 'Quest-log check-in: you just changed a Halo ticket. Call mcp__quest-log__log_ticket_touch with the ticket id, client, url, a short note on what you did, and closedWithHelp if this closed it.'
fi
exit 0
