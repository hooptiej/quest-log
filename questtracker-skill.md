---
name: quest-tracker
description: >
  Captures new project ideas, tasks, and to-dos in hooptiej's self-hosted MU/TH/UR quest log
  as they come up in conversation, and keeps it in sync with the actual work as it happens.
  Use this whenever the user proposes a new idea or project ("we should build X", "let's add
  Y", "I want to try Z" — including sidequests that spin off mid-task), when work starts on
  something, when something ships or gets blocked, or when the user asks what's on their
  list, what's in progress, or what's blocked. Also check in at natural wrap-up points (a
  tangent finishing, a session winding down) to make sure nothing discussed went unrecorded.
  Trigger this proactively — don't wait to be asked to "track" or "log" something explicitly.
compatibility: Requires the quest-log MCP server (tools prefixed mcp__quest-log__) to be connected.
---

# Quest Tracker

hooptiej keeps a running list of projects, ideas, and tasks in a self-hosted tracker called
the quest log — a small web app with checkboxes and status pills (idea / progress / blocked /
done), backed by an MCP server (`quest-log`) so it can be read and updated directly through
tool calls. The point of this skill is to keep that list honest: if something worth tracking
gets discussed, it should end up in the quest log without hooptiej having to ask for it every
time — the same way a good pair-programming partner jots things down without being told to.

## Why this matters

Sessions naturally sidequest — a bug fix turns up a second bug, a feature request reveals a
prerequisite, an idea gets mentioned in passing and then the conversation moves on. Without
something actively capturing these, they get lost the moment the topic changes. The quest log
exists specifically to hold onto that thread so a "main quest" doesn't quietly vanish under a
pile of side quests, and so ideas mentioned once don't have to be re-remembered later.

## When to act

Check in against the tools below whenever one of these happens — not just when explicitly
asked to "track" or "add to the list":

- **A new idea, project, or task comes up.** Someone proposes building something, fixing
  something, or trying something — even offhand ("we should really automate that at some
  point"). Add it.
- **Work starts on something already on the list.** Move it to `progress` if it's currently
  `idea`.
- **Something ships, gets fixed, or is confirmed working.** Mark it `done`.
- **Something hits a real wall** (a licensing block, a missing dependency, a decision that
  needs the user's input before continuing). Mark it `blocked`.
- **The user asks a status question** — "what's left", "what are we tracking", "what's
  blocked" — read the list back rather than guessing from memory.
- **A tangent is wrapping up, or the session is winding down.** Quick gut-check: did anything
  come up in the last stretch that isn't reflected in the list yet?

Use judgment on granularity. Not every tiny sub-step deserves its own entry — the bar is
"would this be useful to see again in a week," not "log every action taken." A one-line fix
made in passing usually belongs in a log entry (see below), not a new quest.

## Tools available

The `quest-log` MCP server exposes:

- `list_quests(status?)` — read the current list, optionally filtered to one status
- `add_idea(title, notes?, status?)` — add something new (defaults to `idea` status)
- `set_quest_status(idOrTitle, status)` — move an existing item between idea/progress/blocked/done
- `add_log_entry(entry, date?)` — append a one-line note to the day's mission log (for things
  worth noting that don't warrant their own tracked quest — a fix, a decision, a milestone)
- `get_full_state()` — the complete raw state, if you need to see everything at once

`idOrTitle` on `set_quest_status` matches by exact id, exact title, or a substring of the
title — so `"scrypted-mcp"` or `"HomeKit pairing"` both work without needing the literal id.

## How to act

Don't ask permission before adding an idea or logging a status change — this is meant to be
low-friction background upkeep, the same way you wouldn't ask permission before taking notes
in a shared doc. Just do it, and mention briefly what you recorded ("noted that as a new idea"
/ "marked the HomeKit fix done") so the user sees it happened, rather than staying silent
about it. If you're unsure whether something is significant enough to track, err toward
logging it as a `add_log_entry` note rather than a full quest — that's the lower-commitment
option, and the user can always promote it to a tracked idea later if it turns out to matter.

If the quest-log tools aren't available (the MCP server isn't connected in this session),
don't block on it or make a big deal of it — just mention once that quest-log isn't reachable
right now, and continue the actual task. Don't repeatedly retry or nag about it.
