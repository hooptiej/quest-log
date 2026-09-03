# CLAUDE.md

Guidance for Claude Code sessions working in this repo. This file is committed and travels via
git across machines (Windows desktop + Mac) — that's the point of it, no custom sync needed.

## What this is

QuestLog: a self-hosted project/idea tracker (checkboxes, status pills, a running mission log)
with an opt-in **Quest → Mission → Task** hierarchy. Personal tool for hooptiej, themed (MU/TH/UR
terminal look by default), not a generic multi-user app. No auth beyond a single shared write
token, no database — meant to run on a trusted local network only.

Three pieces live in this one repo:
- **`/app`** — the web app: `app/server.js` (Express), `app/template.html` (page shell + CSS),
  `app/public/app.js` (all client-side rendering/interaction).
- **`/questhelper`** — QuestHelper, the MCP server (`questhelper/questhelper.js`), formerly a
  separate `quest-log-mcp` repo, merged in 2026-08-30.
- **`/state.js`** (repo root) — the shared state/persistence module both of the above import
  directly. This is what makes them one app, not two services.

## Architecture at a glance

**One Express process, one port.** `app/server.js` builds the `express()` app, adds
`GET /`, `GET/POST /api/state`, and `GET /health`, then calls `attachMcp(app)`
(`questhelper/questhelper.js`) which registers `POST/GET/DELETE /mcp` on that *same* `app`
instance. There is no separate MCP process and no HTTP hop between web app and MCP server — both
call the same `state.js` functions in-process. `questhelper.js` keeps MCP session transports in
an in-memory `{ [sessionId]: transport }` map, so a server restart drops any connected client's
session (tracked as a known limitation, see below).

**Rendering:** the client fetches nothing on load. `GET /` reads `data/state.json` and the HTML
template, splices `JSON.stringify(state)` and the write token directly into the page, and serves
that. Every UI mutation (checkbox, status cycle, new idea) does a full-state `POST /api/state`
with header `X-Write-Token: <token>` back to the server.

**Auth:** `POST /api/state` requires `X-Write-Token` matching a token generated once and
persisted at `data/write-token` (gitignored). The browser gets it embedded in the page via
`GET /`; nothing else exposes it. `GET /api/state` and the `/mcp` routes have no auth — this is
strictly LAN-only, security-through-obscurity-of-network-access.

## Safe embedding of untrusted content (#56/#57)

User-authored note text can contain HTML-like sequences (`</script>`, `<!--`) that could break the
inline script block if not handled carefully. Quest-log uses a two-layer defense:

**Render-side escaping:** `app/render.js`'s `renderIndexHtml()` function escapes all `<` characters
in the state JSON via `.replace(/</g, '\\u003c')` applied *after* all other placeholder substitutions.
This ensures that `</script>` or `<!--` in note text becomes the escaped `</script>` in the
rendered JSON, parsing as a literal string inside the script block, not as a tag boundary. The
render-side fix is primary and always active. `renderIndexHtml` lives in its own file, separate from
`app/server.js`, deliberately — `server.js` has module-level side effects on import (an unconditional
`process.exit(1)` if the data file is missing, an unconditional `app.listen()`), so anything that needs
the pure render function (like the adversarial test below) imports `app/render.js` instead of pulling
in the whole server.

**Write-layer guard:** `questhelper/questhelper.js`'s `validateNoteContent()` function checks
incoming note text in `add_idea`, `update_quest_notes`, and `add_log_entry` tools and rejects
writes containing `</script` or `<!--`. This is defense in depth; it prevents dangerous content
from ever reaching storage, regardless of whether a future change to render-side logic might introduce
a gap.

**Verification:** `scripts/test-adversarial-notes.mjs` is an automated test that seeds the state with
adversarial note content and verifies: (1) the rendered HTML contains valid JavaScript that parses
cleanly via `new Function()`, and (2) the note content round-trips back intact (proving escaping
preserves correctness). The test also proves that the bug would be caught without the fix by
showing the same test fails on a version without escaping applied. Run it with `node scripts/test-adversarial-notes.mjs`.

## Data / state model

State lives entirely in `data/state.json` — **gitignored, never committed**; only
`data/state.example.json` (generic, no real content) ships in the repo. Shape: `{ quests: [],
log: [], designation, _version, _artifact, _maintenance }`.

Each quest/mission/task object: `{ id, title, status, notes, level, parentId, blocked?,
readyToClose?, blockedByDescendant?, _confirmedDone?, _prevStatus?, date? }`.

- `level` is `"quest" | "mission" | "task"`; `PARENT_LEVEL` in `state.js` fixes the tree shape —
  a mission's parent must be a quest, a task's must be a mission, a quest has no parent. Most
  items are still ungrouped missions with `parentId: null` (the original flat list).
- `status` is `"idea" | "progress" | "done"`. `blocked` is a separate boolean flag (not a status)
  — something can be "in progress but blocked".
- **Closing a parent with children is gated, not automatic.** `recomputeRollups` (in `state.js`,
  run after every mutation from both write paths) sets `readyToClose: true` once all children are
  `done`, but never writes `status: "done"` itself. Only the `confirm_completion` MCP tool
  (`state.js`'s `confirmCompletion`) can actually close a parent, and only once it's
  `readyToClose`. Reopening a child clears the parent's `readyToClose` and auto-reverts a
  previously-confirmed-done parent. Both `set_quest_status(..., "done")` and a raw
  `POST /api/state` reject setting `done` directly on anything with children — this can't be
  bypassed from either write path.
- `blockedByDescendant` is purely derived by the same rollup pass (a blocked task marks its
  mission and quest) — never set directly by a tool.

**Write serialization + optimistic locking (still true, verified in `state.js`):**
`mutateState()` chains every read-modify-write through an in-process `Promise` (`writeLock`), so
concurrent writers — multiple browser tabs, overlapping MCP tool calls — can never interleave a
read and a write and corrupt the save; each mutation sees the result of every mutation queued
ahead of it. Separately, every save bumps `state._version`, and `POST /api/state` compares the
client's `_version` against the current one *inside* the same locked mutation — if the state
moved on since the client last loaded it, the request gets `409` instead of silently overwriting
newer data. `state.js` also rejects (`400`) a payload with an invalid/missing quest `status` or a
duplicate `id`. Writes go to a `.tmp-<pid>-<ts>` file and `rename()` into place — no partial-write
corruption on crash.

## MCP (QuestHelper)

Mounted at `POST/GET/DELETE /mcp` on the same server (see above), streamable-HTTP transport.
**21 tools** (trust `questhelper/questhelper.js` as ground truth over any doc, this file
included, if they ever drift): `list_quests`, `add_idea`, `set_quest_status`, `set_blocked`,
`set_archived`, `set_attention`, `confirm_completion`, `promote`, `recruit`, `transfer`,
`delete_quest`, `move`, `rename_quest`, `set_designation`, `update_quest_notes`, `add_log_entry`,
`get_full_state`, `set_maintenance`, `get_artifact_status`, `record_artifact_update`,
`get_mirror_template`.

Session gotcha: an unrecognized `Mcp-Session-Id` gets `404` (not `400`) so a compliant client
reconnects transparently — this matters because sessions are in-memory only and don't survive a
restart/redeploy. `set_maintenance(active: true/false)` lets a session flag an upcoming redeploy
so other open sessions see a warning banner instead of a raw error, but it doesn't prevent the
session drop itself.

`questtracker-skill.md` is a Claude Code skill (installed elsewhere as
`~/.claude/skills/quest-tracker/SKILL.md`) that uses these tools to keep this quest log in sync
with conversations. It also documents a direct REST fallback (`GET/POST /api/state` with the
write token) for when an MCP session is stale.

## Build / run / test

No test suite in this repo. A persistent dev container (`quest-log-dev`) runs on the TrueNAS box
at `/mnt/Storage Pool/home/hoop/hoop/quest-log-dev` for live verification of feature branches.

**Development container workflow:**
```bash
# On TrueNAS box (SSH first: ssh -i ~/.ssh/id_ed25519_truenas hoop@10.0.1.78)
cd /mnt/Storage\ Pool/home/hoop/hoop/quest-log-dev

# Check out your branch (after pushing it)
git fetch origin && git checkout <your-branch>

# Rebuild and redeploy
sudo docker compose -f docker-compose.dev.yml up -d --build

# Verify startup
sudo docker logs quest-log-dev

# The dev server runs on http://10.0.1.78:4243
```

Scripts like `scripts/test-adversarial-notes.mjs` can be run locally against this dev server
or in your local checkout (they read the template and run tests in-process, no server needed).

```bash
# local dev
cp data/state.example.json data/state.json   # first time only; server refuses to start without it
npm install
npm start                                      # node app/server.js, port 4242 by default

# docker (matches production shape)
docker compose up -d --build                   # requires the external `questlog-lan` ipvlan network;
                                                # will fail on any host that hasn't created it
```

For a portable one-off (no `questlog-lan` network available — laptop, work server, Docker
Desktop demo), skip compose and port-map directly; see the README's "Running elsewhere" section
for the exact `docker build` + `docker run -p 8080:80 -e DISABLE_TLS=1 ...` invocation.

`DISABLE_TLS=1` serves plain HTTP; otherwise `docker-entrypoint.sh` generates a self-signed cert
into `./certs` on first boot and `server.js` serves HTTPS whenever `certs/cert.pem`/`key.pem`
exist.

## Deployment

Runs on hooptiej's shared TrueNAS box (host `10.0.1.78`) as a **plain `docker compose` checkout**
— not TrueNAS's "Apps"/catalog system — at a path under
`/mnt/Storage Pool/home/hoop/hoop/quest-log`. The container itself gets its own dedicated LAN IP
(`10.0.1.250` via the `questlog-lan` ipvlan network in `docker-compose.yml`), separate from the
TrueNAS host's own IP.

Redeploy is manual: `git pull` then `sudo docker compose up -d --build` in that checkout.

**That checkout's git history is not fast-forward-only.** Repeated `git pull` there after past
redeploys has accumulated merge commits — this is expected and harmless, not something to "clean
up". If you ever touch that checkout directly, reconcile with `git pull --no-rebase` rather than
resetting or force-pushing over it.

Call `set_maintenance(active: true, note: "...")` via an MCP session before taking the container
down for a redeploy, if you're doing so from a session that has quest-log tools open — it warns
other open sessions instead of letting them hit a raw stale-session error. Clear it
(`active: false`) once the new container is confirmed healthy.

## Gotchas worth knowing up front

- **`data/state.json` is real user data and is gitignored on purpose.** Never try to commit it or
  "fix" the gitignore; use `data/state.example.json` for anything that needs to ship in the repo.
- **Docs drift on the MCP tool count/list.** README and this file were both caught stale during
  the 2026-09-03 doc pass and brought back in sync (21 tools). When in doubt, read
  `questhelper/questhelper.js` directly rather than trusting either doc.
- **MCP sessions don't survive a restart** (in-memory transport map) — a redeploy or crash makes
  every open `mcp__quest-log__*` call in an already-connected session fail with `no valid session
  and not an initialize request` until that client reinitializes. This is a known limitation, not
  a bug to "fix" reflexively.
- **A parent's `status` can only become `"done"` through `confirm_completion`.** Don't try to set
  it directly in code or via a raw state edit — both write paths (`state.js` validation and the
  `set_quest_status` tool) actively reject that.
- **The `questlog-lan` external network is host-specific.** `docker compose up` will fail on any
  machine other than the TrueNAS box with `network questlog-lan declared as external, but could
  not be found` — that's expected there; use the plain `docker run` path instead for local/demo
  use.
