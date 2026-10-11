#!/bin/bash
# SessionStart hook: nudges a fresh session to check quest-log for stale
# "idea" items before diving into work. This covers a different gap than
# the write-triggered hooks (quest-log-checkin.sh, quest-log-write-
# checkin.sh): those only fire when something NEW happens, so a standing
# idea can sit unread for an entire session even with both firing
# correctly, since nothing about writing new state re-surfaces old unread
# state. Supersedes the doc-only echo-based version of this idea in
# questtracker-skill.md's "Automated checkpoint reminders" section.

jq -n --arg ctx 'Session started: early check -- review quest-log for items with status: idea that have not been touched recently. Surface stale ideas to the user before this session progresses, especially if it touches quest-log-adjacent work (issues, PRs, memory, etc.).' \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
