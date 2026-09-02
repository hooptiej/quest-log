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

- `list_quests(status?, level?, tree?)` — read the current list, optionally filtered to one
  status and/or level (`quest`/`mission`/`task`), or as a nested tree instead of flat
- `add_idea(title, notes?, status?, level?, parentIdOrTitle?)` — add something new (defaults to
  `idea` status, `mission` level, no parent). Pass `level` + `parentIdOrTitle` to add a Mission
  under a Quest, or a Task under a Mission
- `set_quest_status(idOrTitle, status)` — move an existing item between idea/progress/blocked/done.
  Rejects a direct move to `done` for anything with children — see `confirm_completion` below
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
- `get_artifact_status()` — whether the mirrored claude.ai Artifact (see below) is due for a
  republish, plus the full state to build it from
- `record_artifact_update(url)` — call after publishing/updating that Artifact, to reset its
  change counter
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
