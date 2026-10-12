#!/bin/bash
# UserPromptSubmit hook: reminds an active Claude Code session to log a new
# ask into quest-log (via add_idea) before scoping or implementing it,
# instead of only being recoverable from conversation scrollback.
#
# Hooked to a real per-message event rather than a timer/poll on purpose --
# this project has already seen a "wait and check periodically" approach be
# unreliable in a way an event-triggered reminder isn't.
#
# Gated on a flag stored in quest-log's own shared state (see
# getAutoLog/setAutoLog in state.js, toggled via the set_auto_log MCP tool)
# rather than a local file, so flipping it from any one of your machines
# takes effect for this hook on every machine with the quest-log plugin
# installed, within about a minute. The flag comes from the server's
# /health via ql_flags (lib.sh), cached per session for a minute (#143), so
# most prompts make no request at all. Stays silent on any network hiccup
# (offline, off-LAN, quest-log down) so a missed reminder never breaks a
# session; the SessionStart hook reports an unreachable server.
#
# Plain text on stdout: UserPromptSubmit adds it to the context as is.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
input="$(cat)"
ql_require quest-log-reminder UserPromptSubmit "$input" curl

ql_flags "$input"
[ "$QL_AUTO_LOG" = 1 ] || exit 0

printf '%s' "If the message just submitted is a new concrete ask (a bug, a feature, a multi-part request), log it into quest-log via add_idea now, with enough detail in the notes to stand alone -- before scoping or starting the implementation. Skip this reminder if the message isn't a new ask (a question, an answer to something already asked, small talk, a reply mid-task, etc.)."
exit 0
