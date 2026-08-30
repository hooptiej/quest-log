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
- `get_artifact_status()` — whether the mirrored claude.ai Artifact (see below) is due for a
  republish, plus the full state to build it from
- `record_artifact_update(url)` — call after publishing/updating that Artifact, to reset its
  change counter

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

## Known limitation: stale MCP session after a quest-log redeploy

`quest-log`'s MCP sessions are in-memory only (open bug:
[hooptiej/quest-log-mcp#2](https://github.com/hooptiej/quest-log-mcp/issues/2)). If the
quest-log container gets redeployed or restarted mid-session, every `mcp__quest-log__*` call
in *this already-open* session will start failing with an error like `no valid session and
not an initialize request` — this is different from the tools simply not being connected at
session start, and it doesn't mean the service is down.

- **First choice:** don't fight it — mention it once and note that a fresh Claude Code session
  will get a clean MCP handshake. Continue the actual task in the meantime.
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
- **Building the mirror:** reuse `state.js`'s rendering shape (status counts, the four quest
  panels, the mission log) and the same MU/TH/UR terminal CSS from `app/template.html` — this
  should look like the real page, not a reformatted summary. Don't embed `window.__WRITE_TOKEN__`
  or any live `fetch("/api/state")` calls in the published Artifact — it's read-only, the token
  is a secret, and the fetch would just fail silently under the Artifact CSP anyway. A small
  "read-only mirror, edit at questlog.local" banner at the top is enough to set expectations.
- **One shared Artifact, not one per session.** The `url` lives in server state precisely so
  every session (any machine) updates the same Artifact instead of each spawning its own —
  always pass the `url` from `get_artifact_status()` back into the `Artifact` tool's `url`
  parameter when republishing, never omit it once one exists.
