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
the quest log — a small web app with checkboxes and status pills (idea / progress / done),
backed by an MCP server (`quest-log`) so it can be read and updated directly through
tool calls. `blocked`, `archived`, and `attention` are separate boolean flags layered on top of
status, not status values themselves (see `set_blocked`/`set_archived`/`set_attention` below) —
something can be "in progress but blocked," for example. The point of this skill is to keep that list honest: if something worth tracking
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
  needs the user's input before continuing). Flag it `blocked` with `set_blocked` — this is a
  separate flag layered on top of status, not a status value itself.
- **The user asks a status question** — "what's left", "what are we tracking", "what's
  blocked" — read the list back rather than guessing from memory.
- **A tangent is wrapping up, or the session is winding down.** Quick gut-check: did anything
  come up in the last stretch that isn't reflected in the list yet?
- **A `done` item is fully wrapped up and shouldn't clutter the view anymore** (even the
  collapsed Completed section) — `set_archived` on it, only with the user's OK, since it's not
  reversible from the UI.
- **Something genuinely needs the user's eyes next session** — a decision pending, a review
  requested — `set_attention` it, and check `list_quests(attention: true)` early in any session
  that touches quest-log to surface what's waiting.
- **Starting a serialized batch across multiple issues/PRs** (e.g. "run tonight's Constructicon
  issues in order, one PR each") — create a Mission for the batch, then `add_idea` a Task under
  it for each item *in the order it'll run*, passing `repo`/`issueNumber` when an item is a real
  GitHub issue. Check progress with `get_batch_status` rather than reconstructing it from prose —
  see "Batch runs" in CLAUDE.md for the full pattern.

Use judgment on granularity. Not every tiny sub-step deserves its own entry — the bar is
"would this be useful to see again in a week," not "log every action taken." A one-line fix
made in passing usually belongs in a log entry (see below), not a new quest.

**Don't duplicate a GitHub issue as a new top-level quest/mission when it already belongs under
one that's already tracked.** If a GitHub issue comes up and its subject matter is really a
sub-part of an existing tracked Quest/Mission, add it as a **Task** under that existing item, not
a redundant new top-level entry — the issue itself is already the durable, closeable unit of work,
so the Task's completion is tied to that issue closing, and quest-log shouldn't grow a second,
parallel top-level entry for the same thing GitHub is already tracking. This only applies when the
issue is genuinely part of something already on the board; an issue that's its own standalone
effort with no existing parent still gets added normally (see above).

## Tools available

The `quest-log` MCP server exposes:

- `list_quests(status?, level?, tree?)` — read the current list, optionally filtered to one
  status and/or level (`quest`/`mission`/`task`), or as a nested tree instead of flat
- `add_idea(title, notes?, status?, level?, parentIdOrTitle?)` — add something new (defaults to
  `idea` status, `mission` level, no parent). Pass `level` + `parentIdOrTitle` to add a Mission
  under a Quest, or a Task under a Mission
- `set_quest_status(idOrTitle, status)` — move an existing item between idea/progress/done.
  Rejects a direct move to `done` for anything with children — see `confirm_completion` below.
  `blocked`, `archived`, and `attention` are separate flags, not status values — use the three
  tools below for those
- `set_blocked(idOrTitle, blocked)` — set or clear the independent `blocked` flag at any level,
  without touching status — something can be "in progress but blocked." Flows uphill for
  display only: a blocked Task marks its Mission and Quest too (`blockedByDescendant`), but only
  the item you call this on actually stores the flag
- `set_archived(idOrTitle, archived)` — set or clear the independent `archived` flag. Archived
  items are genuinely hidden from the default view (unlike `done` items, which just sort into a
  collapsed Completed section) — use this to park items you don't want cluttering even that
  collapsed view. Still reachable via `list_quests(archived: true)`
- `set_attention(idOrTitle, attention)` — set or clear the independent `attention` flag, a
  deliberate manual marker (distinct from any auto-set "unread" signal) for items that need
  active follow-up or discussion in the next session. Check `list_quests(attention: true)` early
  in a session to surface these
- `confirm_completion(idOrTitle)` — the only way to close a Mission or Quest that has children.
  Succeeds once every child under it is done (check `readyToClose` on the item, from
  `list_quests`/`get_full_state`); also works on a plain childless leaf, same as `set_quest_status`
- `add_log_entry(entry, date?)` — append a one-line note to the day's mission log (for things
  worth noting that don't warrant their own tracked quest — a fix, a decision, a milestone)
- `promote(idOrTitle)` — level a Task up to a Mission, or a Mission up to a Quest, in place.
  Fails if the item has children (promote/transfer them first) or is already a Quest
- `recruit(idOrTitle, newParentIdOrTitle)` — bring an existing top-level (parentless) Quest in
  as a Mission under another Quest, or a top-level Mission in as a Task under another Mission.
  Fails if it already has a parent (use `transfer`) or still has children. `idOrTitle` also
  accepts an array to recruit several items under the same `newParentIdOrTitle` in one call —
  each is attempted independently in a single save, so one failure doesn't block the rest; an
  array input gets a per-item array response back instead of a single result
- `transfer(idOrTitle, newParentIdOrTitle)` — move a Mission to a different Quest, or a Task to
  a different Mission (same level, new parent). A Task can only transfer to a Mission under its
  *current* Quest — no cross-Quest Task moves. Same array/batch support as `recruit` above
- `move(idOrTitle, newParentIdOrTitle?)` — move an item and its whole subtree to become a child
  of a new parent, regardless of its current level, parent, or children. The new level is derived
  automatically from the new parent's (one tier down) and every descendant shifts with it. Omit
  `newParentIdOrTitle` to move it to top-level as a Quest. Only fails if a descendant would land
  past Task
- `rename_quest(idOrTitle, newTitle)` — retitle a quest/mission/task in place, independent of
  any level change. `promote`/`recruit`/`move` all keep the title verbatim, so use this to fix a
  title that no longer reads as a good name after a restructure (e.g. before promoting a Mission
  into an umbrella Quest whose current title doesn't work as one)
- `delete_quest(idOrTitle, cascade?)` — permanently remove an item. Refuses if it has children
  unless `cascade: true`, which removes the whole subtree in one call and reports every id
  removed. There's no undo — confirm with the user before deleting anything with real history
- `get_full_state()` — the complete raw state, if you need to see everything at once
- `get_batch_status(idOrTitle)` — status of a serialized multi-issue batch run (#64), tracked as
  a Mission/Quest whose Task children are the batch's items in run order (creation order — add
  them via `add_idea` in the order they'll run). Returns each item's status plus a one-line
  summary ("3 of 6 done, currently on #44"). Pass `repo`/`issueNumber` to `add_idea` when creating
  a batch item that tracks a specific GitHub issue, so it's a structured link, not just prose in
  the title
- `get_artifact_status()` — whether the mirrored claude.ai Artifact (see below) is due for a
  republish, plus the full state to build it from
- `record_artifact_update(url)` — call after publishing/updating that Artifact, to reset its
  change counter
- `get_mirror_template()` — fetch the CSS and read-only render logic for building that mirrored
  Artifact, alongside `get_full_state()` and `get_artifact_status()`
- `set_maintenance(active, note?)` — flag or clear an in-progress/upcoming redeploy — see
  below
- `set_designation(name)` — set the header Designation/name shown in the web UI. The browser
  field only allows a one-time initial entry and then hides itself, so use this tool for any
  change after that first save

`idOrTitle` (and `parentIdOrTitle`) match by exact id, exact title, or a substring of the
title — so `"scrypted-mcp"` or `"HomeKit pairing"` both work without needing the literal id.

## Quest → Mission → Task hierarchy

Every quest has a `level` (`quest`/`mission`/`task`) and a `parentId`. Most items are still
plain ungrouped Missions with no parent — that's the flat list this always was, and nothing
about it needs to change. Use the hierarchy when a project genuinely has that shape: a Quest
(the overall goal) containing Missions (major steps), each optionally broken into Tasks.

**Never call `set_quest_status(..., "done")` on something with children — it will fail on
purpose.** A Mission/Quest only becomes eligible to close once every child under it is done
(the server flags this as `readyToClose: true` automatically). Reaching that flag is not
itself permission to close it: **surface it to the user in conversation and get an explicit
yes** — "the sword mission looks done, all its tasks are checked off — anything else before I
close it out?" — before calling `confirm_completion`. This mirrors how a person would actually
wrap up a project: the last checkbox doesn't auto-close it, someone still looks it over. Don't
call `confirm_completion` on your own judgment alone, and don't nag the user about it if they'd
rather leave something open.

The web UI's quest tree is deliberately read-only — no buttons to change status there — since
this confirmation is meant to happen through the conversation, not a click. The UI does let
someone act directly in two ways: a "+ note" button to capture a quick note as a new child item
for you to triage later, and an "↑ promote" button (wherever `promote` would currently succeed —
it's hidden on a Quest, and hidden on anything with children) that levels the item up in place
the same way the `promote` tool does. `recruit`, `transfer`, `move`, and `delete_quest`
have no UI equivalent — they only happen through conversation with Claude.

### Restructuring: promote / recruit / transfer / move / rename_quest

Five ways to reshape the hierarchy after the fact (until these existed, an item's level, parent,
and title were fixed at creation):

- **Promote** an item that's outgrown its tier — a Task that turned into its own multi-step
  effort, a Mission that turned into something big enough to deserve Missions of its own.
  Refuses if it has children (deal with them first) since there's nowhere valid for a promoted
  Mission's Tasks to land under a Quest.
- **Recruit** an existing standalone Quest or Mission into a bigger one, when you realize two
  things you tracked separately actually belong together. Only works on something both
  parentless and childless — it's meant for absorbing something simple, not restructuring a
  whole subtree at once.
- **Transfer** a Mission or Task that just belongs under a different parent — you filed it under
  the wrong Quest, or a shared Task needs to move to the Mission that actually owns it now. A
  Task can only transfer within its current Quest family (or anywhere, if it isn't under a Quest
  at all yet) — cross-Quest Task moves aren't allowed.
- **Move** is the catch-all for everything promote/recruit/transfer refuse — reparent an item
  (and its whole subtree) under any new parent, regardless of current level, parent, or children,
  across Quest families. The level shift is derived automatically and applied to every descendant
  to preserve the subtree's shape; it only refuses if that shift would push some descendant past
  Task. Reach for this when something was mis-filed from the start (a Task that should've been
  its own Mission under a completely different Quest, or a whole sub-tree that needs to move as
  a unit), not as a routine substitute for the narrower tools above.
- **Rename** a quest/mission/task in place when its current title stopped fitting — most often
  right before a `promote`, when a title that was fine as a Mission doesn't read as a good
  umbrella Quest name.

For a reorg touching several items into the same new parent at once, `recruit` and `transfer`
both accept an array of ids instead of a single one — cuts down the round trips for a reshape
that would otherwise be one call per item.

None of these are gated by user confirmation the way `confirm_completion` is — reshaping the
tree isn't the same kind of one-way door as marking something done, so use judgment same as
`add_idea`/`set_quest_status` rather than treating it as high-stakes. Do mention what you did
("promoted the sword-crafting task up to its own mission") so it's not a silent structural
change.

## How to act

Don't ask permission before adding an idea or logging a status change — this is meant to be
low-friction background upkeep, the same way you wouldn't ask permission before taking notes
in a shared doc. Just do it, and mention briefly what you recorded ("noted that as a new idea"
/ "marked the HomeKit fix done") so the user sees it happened, rather than staying silent
about it. If you're unsure whether something is significant enough to track, err toward
logging it as a `add_log_entry` note rather than a full quest — that's the lower-commitment
option, and the user can always promote it to a tracked idea later if it turns out to matter.

**Sync the instant the triggering event happens, in the same turn — not batched, not deferred
until asked.** A PR merge, a deploy you just verified live, a bug you just confirmed fixed: the
quest-log update belongs immediately after that action, not saved up for a "let's update the
quest log" request at the end. Concretely: the moment a status change makes a Mission/Quest's
`readyToClose` flag turn true, surface it to the user right then ("the sword mission looks done,
all its tasks are checked off — anything else before I close it out?") in that same turn,
rather than leaving it flagged for a later "close out completed items" ask. Getting explicit
confirmation before `confirm_completion` (see above) is still required — the instruction here
is about *when* you check and surface it, not about skipping that confirmation step.

If the quest-log tools aren't available (the MCP server isn't connected in this session),
don't block on it or make a big deal of it — just mention once that quest-log isn't reachable
right now, and continue the actual task. Don't repeatedly retry or nag about it.

## Automated checkpoint reminders (Claude Code hooks)

The instructions above rely on Claude noticing the right moments on its own. As a backstop —
not a replacement — this skill's home machine also has a set of Claude Code hooks
(`~/.claude/settings.json`) that inject a reminder at the moments most likely to mean
quest-log needs an update. These are **not portable via this repo** (hooks live in a
machine-local config file, not git), so if quest-log is being used from a new machine, add
this block manually to that machine's `~/.claude/settings.json` (merge into any existing
`hooks`/`permissions` keys, don't overwrite them) to get the same backstop there:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "if": "Bash(git commit *)", "command": "echo '{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": \"Git commit completed. Consider checking quest-log to log this checkpoint or milestone.\"}}'" },
          { "type": "command", "if": "Bash(git push *)", "command": "echo '{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": \"Git push completed. Consider checking quest-log if this merge or push should be logged as a milestone.\"}}'" },
          { "type": "command", "if": "Bash(gh pr create *)", "command": "echo '{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": \"Pull request created. New PRs often represent completed features — consider updating quest-log with this work.\"}}'" },
          { "type": "command", "if": "Bash(gh issue close *)", "command": "echo '{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": \"Issue closed. This likely represents completed work — check quest-log to ensure this closure is logged.\"}}'" },
          { "type": "command", "if": "Bash(gh issue create *)", "command": "echo '{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": \"Issue created. New issues often signal scope changes or discovered blockers — consider updating quest-log status or dependencies.\"}}'" },
          { "type": "command", "if": "Bash(gh issue comment *)", "command": "echo '{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": \"Issue comment posted. Design decisions and scope discussions often happen in comments — check if quest-log should reflect this.\"}}'" }
        ]
      },
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "if": "Write(*CLAUDE.md)", "command": "echo '{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": \"CLAUDE.md file written. This often documents critical context — consider updating quest-log if scope, blockers, or decisions changed.\"}}'" },
          { "type": "command", "if": "Edit(*CLAUDE.md)", "command": "echo '{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": \"CLAUDE.md file edited. This often reflects context updates — consider syncing changes to quest-log.\"}}'" },
          { "type": "command", "if": "Write(*memory*)", "command": "echo '{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": \"Memory file written (auto-memory capture). Consider whether this learned context should be synced to quest-log.\"}}'" },
          { "type": "command", "if": "Edit(*memory*)", "command": "echo '{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": \"Memory file edited. Consider syncing important context updates to quest-log for future reference.\"}}'" }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "echo '{\"hookSpecificOutput\": {\"hookEventName\": \"SessionStart\", \"additionalContext\": \"Session started: early check — review quest-log for items with status: idea that haven't been touched recently. Surface stale ideas to the user before this session progresses, especially if it touches quest-log-adjacent work (issues, PRs, memory, etc.).\"}}'" },
          { "type": "command", "command": "echo '{\"hookSpecificOutput\": {\"hookEventName\": \"SessionStart\", \"additionalContext\": \"Session started: if this session ends up calling any quest-log tool, check mcp__quest-log__get_artifact_status early and call mcp__quest-log__record_artifact_update after republishing if it reports needsUpdate — the artifact mirror only stays current if a session actually acts on that flag, not just notices the warning text.\"}}'" },
          { "type": "command", "command": "echo '{\"hookSpecificOutput\": {\"hookEventName\": \"SessionStart\", \"additionalContext\": \"Session started: if calling any quest-log tool, check for attention-flagged items with mcp__quest-log__list_quests(attention: true) — these are items the owner explicitly marked for active follow-up in this session, distinct from passive markers. Surface them early for discussion.\"}}'" }
        ]
      }
    ]
  }
}
```

**Why these specific triggers** (worth keeping if this ever gets redesigned): an earlier, narrower
version of this idea (only `git commit`/`git push`/`gh pr create`/`gh issue close`) was tested
against a real session's actual tool-call history before being built, and would have missed most
of that session's real quest-log-relevant moments — new issues being filed (`gh issue create`) and
design/scope decisions happening in comments (`gh issue comment`) were the biggest gaps, plus
anything non-git entirely (CLAUDE.md writes, memory writes) was invisible to a Bash-only hook.
The `SessionStart` idea-board nudge exists for a different reason: a standing idea can sit unread
for an entire session even with the write-triggered hooks firing correctly, because nothing about
*writing* new state re-surfaces *old* unread state — that's a periodic-read gap, not a
write-trigger gap.

A hook can only inject a reminder via `additionalContext` — it's a shell command, it cannot call
quest-log's MCP tools directly. The actual sync/check still has to come from Claude reacting to
that reminder in a live turn.

## Known limitation: stale MCP session after a quest-log redeploy

`quest-log`'s MCP sessions are in-memory only (open bug:
[hooptiej/quest-log-mcp#2](https://github.com/hooptiej/quest-log-mcp/issues/2)). If the
quest-log container gets redeployed or restarted mid-session, every `mcp__quest-log__*` call
in *this already-open* session will start failing with an error like `no valid session and
not an initialize request` — this is different from the tools simply not being connected at
session start, and it doesn't mean the service is down. `set_maintenance` doesn't fix this
(sessions still can't survive the restart), but it turns the surprise into an expected event:

- **If you're the one about to redeploy quest-log**, call
  `set_maintenance(active: true, note: "...")` *before* taking the container down. Any other
  session with quest-log tools open will see a `⚠️ quest-log maintenance flagged...` banner
  prepended to its next `list_quests` / `get_full_state` / `get_artifact_status` call, so it
  can warn the user proactively instead of just erroring blind. Call
  `set_maintenance(active: false)` once the new container is confirmed healthy — don't leave
  it flagged.
- **If you hit the stale-session error yourself** (with no banner having warned you first) —
  don't fight it — mention it once and note that a fresh Claude Code session will get a clean
  MCP handshake. Continue the actual task in the meantime.
- **If a write genuinely can't wait**, quest-log's own REST API works as a direct fallback and
  bypasses the MCP session entirely:
  - Read: `GET http://questlog.local/api/state` (or `http://10.0.1.250/api/state`) — no auth
    needed.
  - Write: `POST` to the same URL with header `X-Write-Token: <token>` and the full
    `{quests, log, _version}` body (send back the `_version` you just read, or the write gets
    rejected with 409). The token lives server-side; the only place to get it without SSH
    access to the TrueNAS box is `window.__WRITE_TOKEN__` on the loaded page itself (open
    `http://questlog.local/` in a browser tool and read that global).
  - This fallback writes go through the same validation/locking as normal MCP writes — it's
    the same state.json, just a different door in.

## Release versioning

quest-log tracks releases using `MAJOR.MINOR.PATCH` where PATCH is zero-padded to 2 digits:

- **MAJOR** (e.g. 1 → 2): a full release — significant feature set or architectural change.
- **MINOR** (`.x`, e.g. 1.0 → 1.1): a "major build" — a significant feature or change set.
- **PATCH** (`.0X`, zero-padded, e.g. 1.0.00 → 1.0.01): an incremental fix or polish.

The version is maintained in `package.json` as the canonical source and is exposed in:

- The running app's UI footer: `v1.0.00` visible in the page.
- The `/health` endpoint: `GET /health` returns `{"status": "ok", "version": "1.0.00"}`.

When bumping: update `package.json`'s `version` field with the new version, then commit as normal.

**This is easy to forget mid-PR since it's not part of the change itself — it went unbumped for
7 merges (see #70) before anyone noticed.** Treat it as a standing checklist item: before merging
any PR that ships a real feature or fix (not a docs-only change), decide whether it's a
MINOR/PATCH bump and include it in that PR, or as its own immediate follow-up if it was missed.

## Keeping the mirrored Artifact in sync

hooptiej also keeps a claude.ai Artifact ("MU/TH/UR Quest Log") as a read-only visual mirror
of this quest log, so it's viewable without hitting the LAN server. This mirror does **not**
try to stay live-identical — Artifacts can't fetch from the LAN (strict CSP, no external
requests except Google Fonts), so it's necessarily a periodic snapshot, not a live view. The
server tracks drift itself via `_artifact` in its state, so you don't have to judge staleness
by eye:

- **At the start of any session that uses quest-log tools**, call `get_artifact_status()`
  once and sync unconditionally — create the Artifact if `url` is `null`, otherwise republish
  it (same file path / same `url` passed to `Artifact`, so it updates in place rather than
  forking a new one) — regardless of whether `needsUpdate` says it's due. This is the
  session-open snapshot.
- **After any quest-log write during the session**, check the `needsUpdate` field from that
  same tool's response (or call it again if you didn't just call it). If `true` — a mainquest
  changed (any status change or new quest, via any write path) or 10+ smaller changes
  (notes edits, log entries) have piled up since the last sync — republish and call
  `record_artifact_update(url)` immediately after. Don't defer this or batch it up further;
  the threshold logic already handles batching.
- **Building the mirror:** Call the new `get_mirror_template()` MCP tool to fetch `{css, renderCode, renderFunctions, version}`. Combine the returned `css` and `renderCode` with the quest state from `get_full_state()` or `get_artifact_status()` to build the artifact. The `renderCode` is a read-only render function that takes state as input — the Artifact should invoke this to render the UI from the current state. Don't embed `window.__WRITE_TOKEN__` or any live `fetch("/api/state")` calls in the published Artifact — it's read-only, the token is a secret, and the fetch would just fail silently under the Artifact CSP anyway. A small "read-only mirror, edit at questlog.local" banner at the top is enough to set expectations.
- **One shared Artifact, not one per session.** The `url` lives in server state precisely so
  every session (any machine) updates the same Artifact instead of each spawning its own —
  always pass the `url` from `get_artifact_status()` back into the `Artifact` tool's `url`
  parameter when republishing, never omit it once one exists.
