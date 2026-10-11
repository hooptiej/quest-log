# quest-log as a Claude Code plugin: hooks that fire everywhere

Issue: hooptiej/quest-log#142. Decided with the owner 2026-10-10.

## Problem

quest-log ships seven check-in hooks meant to keep the tracker in step with real work. They are
registered in `quest-log/.claude/settings.json` (project scope), with commands of the form
`"${CLAUDE_PROJECT_DIR}/.claude/hooks/<script>" 2>/dev/null || true`. So:

- they only run in sessions opened inside the quest-log checkout, never in the Constructicon,
  homedash or workspace-root sessions where most work happens;
- copied to user scope as written, they would still fail, because `CLAUDE_PROJECT_DIR` points at
  whatever project is open and `|| true` hides the failure;
- the docs (`CLAUDE.md` "Backstop check-in hooks", `questtracker-skill.md`) say "no per-machine
  setup needed", which is the faulty premise.

The 2026-10-10 judgment pass found weeks of drift these hooks exist to catch (Constructicon#310
closed but its quest stayed `idea`; review #564 and migration #416 done under other names).

## Decisions

1. **Ship the Claude side of quest-log as a Claude Code plugin**, from this repo, which is its own
   marketplace (the same pattern as `obra/superpowers`). Installed at user scope, once per machine.
2. **The plugin carries the hooks and the quest-tracker skill. It does NOT carry the MCP server
   entry.** Each machine keeps its own `quest-log` entry in `~/.claude.json`, because machines may
   point at different quest-log servers (the work install). Hooks read the server from
   `QUEST_LOG_URL` (default `http://questlog.local/api/state`), as they already do.
3. **Deploys are always Claude-driven** (owner: "I'm not ever going to deploy it without Claude
   helping"). Reinstalling the hooks is therefore a written step in the instructions every machine's
   Claude reads, plus a version check that tells any machine that missed a deploy.

## Layout (repo root)

```
.claude-plugin/
  plugin.json          name "quest-log", version = the HOOKS version (see Versioning)
  marketplace.json     marketplace "quest-log", one plugin, source "./"
hooks/
  hooks.json           the seven registrations, commands use ${CLAUDE_PLUGIN_ROOT}
  quest-log-*.sh, quest-log-reminder.mjs   moved from .claude/hooks/
skills/
  quest-tracker/SKILL.md   the single copy of the skill (from questtracker-skill.md)
```

- `.claude/hooks/` and the `hooks` block of `.claude/settings.json` are **removed**, so a session
  inside the quest-log repo doesn't fire everything twice. Any non-hook project settings stay.
- `questtracker-skill.md` is moved (`git mv`) to `skills/quest-tracker/SKILL.md`, and every
  reference to the old path (CLAUDE.md, README, the family diagram) is updated. The machine-local copy in `~/.claude/skills/quest-tracker/` is
  deleted on each machine as part of installing the plugin (and from `hooptiej/claude-config`).
- Hook commands: `bash "${CLAUDE_PLUGIN_ROOT}/hooks/<script>.sh"` with `"shell": "bash"`, and
  `node "${CLAUDE_PLUGIN_ROOT}/hooks/quest-log-reminder.mjs"`. Registrations keep their current
  events and matchers (UserPromptSubmit; PostToolUse on Bash, Write|Edit, Agent,
  `mcp__.*__add_idea`, `mcp__.*__halopsa_tickets_.*`; SessionStart).

## No more silent failure

- Drop `2>/dev/null || true`. Each script still exits 0 (a reminder must never block a tool
  call), but on an internal failure it emits a one-line `additionalContext`, for example
  "quest-log hook <name> could not run: jq not found".
- The **SessionStart** hook runs a preflight once per session: it checks for `bash`, `jq`, `curl`
  and `node` and names any that are missing. On Windows, Git Bash provides bash and curl; the Mac
  may lack `jq` or `node`.

## Versioning and the redeploy handshake

- **The hooks version is `.claude-plugin/plugin.json` `version`.** It is separate from the server
  version in `package.json`, and is bumped only when anything under `hooks/` or `skills/` changes.
  (`claude plugin update` only picks up a new version.)
- **The server reports it.** The Dockerfile adds `COPY .claude-plugin ./.claude-plugin`, and
  `/health` returns `{status, version, hooksVersion}`, read from that file at startup.
- **The SessionStart hook compares** its own `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`
  version with `hooksVersion` from the server (derived from `QUEST_LOG_URL`'s origin + `/health`,
  1.5 s timeout, a network failure says "couldn't reach quest-log" once rather than nothing). On a
  mismatch it injects:
  "quest-log hooks on this machine are vX, the server ships vY. Update: `claude plugin
  marketplace update quest-log` then `claude plugin update quest-log@quest-log`, then restart."

## One SessionStart message

`quest-log-session-start.sh` today only nudges about stale `idea` items; the attention reminder
lives separately as a one-liner in `~/.claude/settings.json`. The rewritten script emits one
combined message: the preflight result (only if something is missing), the version check (only on
a mismatch or an unreachable server), then the standing nudges: check `list_quests(attention:
true)` and surface flagged items early, and review stale `idea` items.

## Instructions (where each machine's Claude reads them)

1. **`quest-log/CLAUDE.md` → Deployment**, an explicit final step after the container is healthy:
   "If this deploy changed `hooks/` or `skills/` (the plugin version moved): on this machine run
   `claude plugin marketplace update quest-log` and `claude plugin update quest-log@quest-log`,
   restart, and confirm the SessionStart line reports the new version. Other machines are told at
   their next session start." Also add a "bump `.claude-plugin/plugin.json` when hooks change"
   rule next to the existing package.json version rule.
2. **`~/.claude/CLAUDE.md`** (synced to every machine via `hooptiej/claude-config`), in the MCP
   section: "quest-log's hooks and skill come from the `quest-log` plugin, installed per machine:
   `claude plugin marketplace add hooptiej/quest-log` then `claude plugin install
   quest-log@quest-log`. If a session reports the hooks missing or stale, install or update it.
   The MCP server entry stays in `~/.claude.json`."
3. **The SessionStart message itself** (above) carries the exact command.
4. Fix the "no per-machine setup" text in `CLAUDE.md` "Backstop check-in hooks" and in the skill,
   and update `docs/questlog-family.svg`'s hooks box if it names paths.

## Rollout

1. Merge the plugin PR; deploy the server (for `/health` `hooksVersion`).
2. On each machine (Windows desktop now; the Mac and the work machine at their next session,
   prompted by the `~/.claude/CLAUDE.md` rule): add the marketplace, install the plugin, delete
   `~/.claude/skills/quest-tracker/`, restart.
3. Remove the one-line attention SessionStart hook from `~/.claude/settings.json` (and push
   claude-config). The plugin's `quest-log-session-start.sh` takes over its text (see "One
   SessionStart message"), so keeping it would only say it twice.

## Testing

- `claude plugin validate .` on the repo (manifest, marketplace, skill, hooks).
- Install from the branch on this machine (`claude plugin marketplace add <local checkout path>`),
  then start a session in a **different** folder and confirm: the SessionStart line appears; a
  `gh issue view` (PostToolUse/Bash) nudge appears; the reminder fires on a prompt.
- Version handshake against `quest-log-dev` (`QUEST_LOG_URL` pointed at it): matching versions say
  nothing extra; a bumped server-side `hooksVersion` produces the update message; an unreachable
  server produces the single "couldn't reach" line.
- Preflight: run the SessionStart script with `jq` removed from `PATH` and confirm it names it.
- `/health` on dev returns `hooksVersion`.

## Out of scope

- Server-side GitHub issue sync (flagging quests whose linked issue closed): the cheaper, tokenless
  half of the drift fix, worth its own issue.
- A rule that every filed issue gets linked to a quest (`repo`/`issueNumber`): a skill/CLAUDE.md
  wording change, can ride along in the skill text here if small.
- The MCP server entry in the plugin (decided against, see Decisions).
