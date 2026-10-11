# quest-log Plugin (hooks that fire everywhere) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship quest-log's check-in hooks and the QuestTracker skill as a user-scope Claude Code plugin, so the hooks fire in every project, never fail silently, and tell a machine when its copy is out of date.

**Architecture:** The quest-log repo becomes its own plugin marketplace (`.claude-plugin/`), with the hooks moved from `.claude/hooks/` to `hooks/` (registered in `hooks/hooks.json` via `${CLAUDE_PLUGIN_ROOT}`) and the skill moved to `skills/quest-tracker/`. A shared `hooks/lib.sh` replaces the old `2>/dev/null || true` with once-per-session "can't run" messages. The server reports the plugin's version on `/health` as `hooksVersion`, and the SessionStart hook compares it with its own.

**Tech Stack:** bash + jq + curl (hook scripts), Node 22 ESM (server, the reminder hook, tests), Claude Code plugin manifests, Docker Compose on TrueNAS.

**Spec:** `docs/superpowers/specs/2026-10-10-quest-log-plugin-design.md` (issue hooptiej/quest-log#142)

## Global Constraints

- Branch: `plugin-hooks-142` (already exists, holds the spec). Repo: `C:\Users\hoopt\Claude Code\quest-log`.
- Plugin name `quest-log`, marketplace name `quest-log`, install id `quest-log@quest-log`.
- Initial plugin (hooks) version: `1.0.0`. Server version bump: `package.json` `1.1.01` → `1.2.00`.
- The plugin does NOT contain an MCP server entry. Hooks reach the server via `QUEST_LOG_URL` (default `http://questlog.local/api/state`).
- Every hook script exits 0. None may block a tool call.
- Hook commands use `${CLAUDE_PLUGIN_ROOT}`; never `CLAUDE_PROJECT_DIR`, `2>/dev/null` or `|| true`.
- Hook files are LF-only (`.gitattributes`). Edit existing files with the Edit tool (working copies here are CRLF; see `~/.claude/CLAUDE.md` "Line endings").
- Tests are plain Node scripts (no framework), same as the existing `scripts/test-*.mjs`. Run them from Git Bash so `bash` and `jq` resolve; set `QL_BASH` to Git's bash if `bash` resolves to WSL.
- Exact update commands everywhere: `claude plugin marketplace update quest-log` then `claude plugin update quest-log@quest-log`, then restart. Install: `claude plugin marketplace add hooptiej/quest-log` then `claude plugin install quest-log@quest-log`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Plugin skeleton (manifests, move hooks + skill, registrations)

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`, `.gitattributes`, `scripts/test-plugin-hooks.mjs`
- Move: `.claude/hooks/*` → `hooks/`, `questtracker-skill.md` → `skills/quest-tracker/SKILL.md`
- Delete: `.claude/settings.json` (it contains only hook registrations)

**Interfaces:**
- Produces: `hooks/<script>` paths used by every later task; `scripts/test-plugin-hooks.mjs` with helpers `check(name, ok, detail)`, `runHook(script, input, env) -> Promise<{code, stdout, stderr}>`, `context(stdout) -> string`, `stubServer({hooksVersion, proMode}) -> Promise<http.Server>`, and constants `ROOT`, `HOOKS`, `TMP`. Later tasks insert test blocks above the `// --- end ---` marker.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-plugin-hooks.mjs`:

```js
// Tests for the quest-log Claude Code plugin (#142): manifests, hook
// registrations, and each hook script's output. No framework, same as the
// other scripts/test-*.mjs:  node scripts/test-plugin-hooks.mjs
// Needs bash and jq on PATH (Git Bash on Windows). Set QL_BASH to a bash
// binary if `bash` resolves to the wrong one (e.g. WSL's).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = join(ROOT, "hooks");
const BASH = process.env.QL_BASH || "bash";
const TMP = mkdtempSync(join(tmpdir(), "ql-hooks-")).replace(/\\/g, "/");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

function runHook(script, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(BASH, [join(HOOKS, script).replace(/\\/g, "/")], {
      env: { ...process.env, TMPDIR: TMP, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

// The additionalContext text a hook emitted, or "" if it stayed quiet.
function context(stdout) {
  if (!stdout.trim()) return "";
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}

// A tiny stand-in quest-log: GET /health and GET /api/state.
function stubServer({ hooksVersion, proMode = false }) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") res.end(JSON.stringify({ status: "ok", version: "0.0.0", hooksVersion }));
      else res.end(JSON.stringify({ quests: [], _proMode: proMode }));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// --- manifests and registrations (Task 1) ---
{
  const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
  let plugin = {}, market = {}, hooksJson = { hooks: {} };
  try {
    plugin = read(".claude-plugin/plugin.json");
    market = read(".claude-plugin/marketplace.json");
    hooksJson = read("hooks/hooks.json");
  } catch (e) {
    check("manifests readable", false, e.message);
  }
  check("plugin name is quest-log", plugin.name === "quest-log", plugin.name);
  check("plugin version is x.y.z", /^\d+\.\d+\.\d+$/.test(plugin.version ?? ""), plugin.version);
  const entry = market.plugins?.[0] ?? {};
  check("marketplace is named quest-log", market.name === "quest-log", market.name);
  check("marketplace lists quest-log at ./", entry.name === "quest-log" && entry.source === "./", JSON.stringify(entry));
  check("marketplace version matches plugin.json", entry.version === plugin.version, `${entry.version} vs ${plugin.version}`);
  const commands = Object.values(hooksJson.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
  check("7 hook commands registered", commands.length === 7, String(commands.length));
  for (const c of commands) {
    check(`uses CLAUDE_PLUGIN_ROOT: ${c}`, c.includes("${CLAUDE_PLUGIN_ROOT}") && !c.includes("CLAUDE_PROJECT_DIR"));
    check(`doesn't swallow errors: ${c}`, !c.includes("|| true") && !c.includes("2>/dev/null"));
    const file = (c.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/) ?? [])[1] ?? "";
    check(`script exists: ${file}`, file !== "" && existsSync(join(ROOT, file)));
  }
  check("skill lives in the plugin", existsSync(join(ROOT, "skills/quest-tracker/SKILL.md")));
  check("no project-scoped hooks left", !existsSync(join(ROOT, ".claude/settings.json")) && !existsSync(join(ROOT, ".claude/hooks")));
}

// --- end ---
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node scripts/test-plugin-hooks.mjs`
Expected: `FAIL  manifests readable`, `FAIL  7 hook commands registered`, `FAIL  skill lives in the plugin`, `FAIL  no project-scoped hooks left`; exit 1.

- [ ] **Step 3: Move the hooks and the skill, drop the project registrations**

```bash
cd "/c/Users/hoopt/Claude Code/quest-log"
mkdir -p hooks skills/quest-tracker .claude-plugin
git mv .claude/hooks/quest-log-agent-checkin.sh .claude/hooks/quest-log-checkin.sh \
  .claude/hooks/quest-log-halo-checkin.sh .claude/hooks/quest-log-hierarchy-checkin.sh \
  .claude/hooks/quest-log-reminder.mjs .claude/hooks/quest-log-session-start.sh \
  .claude/hooks/quest-log-write-checkin.sh hooks/
git mv questtracker-skill.md skills/quest-tracker/SKILL.md
git rm -q .claude/settings.json
ls .claude   # only worktrees/ (untracked) should remain
```

- [ ] **Step 4: Write the manifests**

`.claude-plugin/plugin.json`:

```json
{
  "name": "quest-log",
  "description": "QuestTracker skill + check-in hooks that keep hooptiej's quest log in sync with real work, in every project",
  "version": "1.0.0",
  "author": { "name": "hooptiej" },
  "homepage": "https://github.com/hooptiej/quest-log",
  "repository": "https://github.com/hooptiej/quest-log",
  "license": "MIT",
  "keywords": ["quest-log", "tracker", "hooks", "skills"]
}
```

`.claude-plugin/marketplace.json`:

```json
{
  "name": "quest-log",
  "description": "The quest-log Claude Code plugin, served straight from the quest-log repo",
  "owner": { "name": "hooptiej" },
  "plugins": [
    {
      "name": "quest-log",
      "description": "QuestTracker skill + check-in hooks that keep hooptiej's quest log in sync with real work, in every project",
      "version": "1.0.0",
      "source": "./",
      "author": { "name": "hooptiej" }
    }
  ]
}
```

`hooks/hooks.json` (same events and matchers as the deleted `.claude/settings.json`):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "shell": "bash", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/quest-log-reminder.mjs\"" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "shell": "bash", "command": "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/quest-log-checkin.sh\"" }
        ]
      },
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "shell": "bash", "command": "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/quest-log-write-checkin.sh\"" }
        ]
      },
      {
        "matcher": "mcp__.*__halopsa_tickets_.*",
        "hooks": [
          { "type": "command", "shell": "bash", "command": "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/quest-log-halo-checkin.sh\"" }
        ]
      },
      {
        "matcher": "Agent",
        "hooks": [
          { "type": "command", "shell": "bash", "command": "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/quest-log-agent-checkin.sh\"" }
        ]
      },
      {
        "matcher": "mcp__.*__add_idea",
        "hooks": [
          { "type": "command", "shell": "bash", "command": "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/quest-log-hierarchy-checkin.sh\"" }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "shell": "bash", "command": "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/quest-log-session-start.sh\"" }
        ]
      }
    ]
  }
}
```

`.gitattributes` (a plugin install is a git clone; on a CRLF machine the scripts must still be LF):

```
hooks/* text eol=lf
.claude-plugin/*.json text eol=lf
skills/**/*.md text eol=lf
```

Then renormalize: `git add .gitattributes && git add --renormalize hooks .claude-plugin skills`

- [ ] **Step 5: Run the tests and the validator**

Run: `node scripts/test-plugin-hooks.mjs` → Expected: all PASS, exit 0.
Run: `claude plugin validate .` → Expected: no errors (warnings about optional fields are fine; fix any error it names).

- [ ] **Step 6: Commit**

```bash
git add -A .claude-plugin hooks skills .gitattributes scripts/test-plugin-hooks.mjs
git status --short   # expect: renames into hooks/ and skills/, deleted .claude/settings.json, new files
git commit -m "feat: ship quest-log's hooks + QuestTracker skill as a Claude Code plugin (#142)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: No silent failures (hooks/lib.sh + the PostToolUse hooks)

**Files:**
- Create: `hooks/lib.sh`
- Modify: `hooks/quest-log-checkin.sh`, `hooks/quest-log-write-checkin.sh`, `hooks/quest-log-hierarchy-checkin.sh`, `hooks/quest-log-agent-checkin.sh`, `hooks/quest-log-halo-checkin.sh`
- Test: `scripts/test-plugin-hooks.mjs`

**Interfaces:**
- Consumes: `runHook`, `context`, `stubServer`, `check` from Task 1.
- Produces (`hooks/lib.sh`, sourced by every `.sh` hook): `QL_STATE_DIR`; `ql_emit EVENT TEXT` (prints the hookSpecificOutput JSON, no jq needed); `ql_session_id JSON` (prints session_id, no jq needed); `ql_has TOOL` (honours `QL_HIDE_TOOLS`, a space-separated list used by tests to simulate a missing tool); `ql_require HOOK EVENT INPUT TOOL...` (returns if all tools exist, else reports once per session and `exit 0`); `ql_mark_reported INPUT` (marks this session's "missing tools" message as already shown).

- [ ] **Step 1: Write the failing tests**

Insert above `// --- end ---` in `scripts/test-plugin-hooks.mjs`:

```js
// --- PostToolUse hooks (Task 2) ---
{
  const sid = `t2-${Date.now()}`;
  let r = await runHook("quest-log-checkin.sh", { session_id: sid, tool_input: { command: "git commit -m x" } });
  check("checkin: fires on git commit", context(r.stdout).startsWith("Quest-log check-in"), r.stdout + r.stderr);
  r = await runHook("quest-log-checkin.sh", { session_id: sid, tool_input: { command: "ls -la" } });
  check("checkin: quiet on ls", r.stdout.trim() === "" && r.code === 0, r.stdout + r.stderr);
  r = await runHook("quest-log-write-checkin.sh", { session_id: sid, tool_input: { file_path: "C:/x/CLAUDE.md" } });
  check("write-checkin: fires on CLAUDE.md", context(r.stdout).includes("quest-log"), r.stdout + r.stderr);
  r = await runHook("quest-log-write-checkin.sh", { session_id: sid, tool_input: { file_path: "src/app.js" } });
  check("write-checkin: quiet on app.js", r.stdout.trim() === "", r.stdout);
  r = await runHook("quest-log-hierarchy-checkin.sh", { session_id: sid, tool_name: "mcp__quest-log__add_idea", tool_input: { title: "x" } });
  check("hierarchy: fires on a parentless mission", context(r.stdout).includes("no parent"), r.stdout + r.stderr);
  r = await runHook("quest-log-hierarchy-checkin.sh", { session_id: sid, tool_name: "mcp__quest-log__add_idea", tool_input: { title: "x", parentIdOrTitle: "p" } });
  check("hierarchy: quiet with a parent", r.stdout.trim() === "", r.stdout);
  r = await runHook("quest-log-agent-checkin.sh", { session_id: sid, tool_name: "Agent" });
  check("agent: quiet on the first dispatch", r.stdout.trim() === "", r.stdout);
  r = await runHook("quest-log-agent-checkin.sh", { session_id: sid, tool_name: "Agent" });
  check("agent: nudges on the second dispatch", context(r.stdout).includes("2 background agents"), r.stdout + r.stderr);

  const halo = await stubServer({ hooksVersion: "1.0.0", proMode: true });
  const url = `http://127.0.0.1:${halo.address().port}/api/state`;
  r = await runHook("quest-log-halo-checkin.sh", { session_id: sid, tool_name: "mcp__halo__halopsa_tickets_get" }, { QUEST_LOG_URL: url });
  check("halo: view nudge when Pro Mode is on", context(r.stdout).includes("log_ticket_view"), r.stdout + r.stderr);
  halo.close();

  // A machine without jq: say so once per session, then stay quiet.
  const sid2 = `t2-nojq-${Date.now()}`;
  r = await runHook("quest-log-checkin.sh", { session_id: sid2, tool_input: { command: "git push" } }, { QL_HIDE_TOOLS: "jq" });
  check("missing jq: named once", context(r.stdout).includes("missing jq") && r.code === 0, r.stdout + r.stderr);
  r = await runHook("quest-log-write-checkin.sh", { session_id: sid2, tool_input: { file_path: "CLAUDE.md" } }, { QL_HIDE_TOOLS: "jq" });
  check("missing jq: not repeated in the same session", r.stdout.trim() === "" && r.code === 0, r.stdout);
}
```

- [ ] **Step 2: Run and confirm the new checks fail**

Run: `node scripts/test-plugin-hooks.mjs`
Expected: the Task 1 checks and most Task 2 checks PASS (the old scripts already behave), but `FAIL  missing jq: named once` (the old scripts don't know `QL_HIDE_TOOLS`). If `checkin: fires on git commit` fails because of a JSON parse error, the old script's multi-line `jq -n` output is the cause; that also gets fixed in Step 3.

- [ ] **Step 3: Create `hooks/lib.sh`**

```bash
# quest-log plugin: helpers sourced by every hooks/*.sh script (#142).
#
# A hook must never block a tool call, so every script exits 0. What this
# adds over the old `2>/dev/null || true` is that a hook that CAN'T run
# (a tool missing on this machine) says so once per session instead of
# vanishing. ql_emit needs no jq, so the "can't run" message works even
# when jq is the missing piece.

QL_STATE_DIR="${TMPDIR:-/tmp}/quest-log-hooks"

ql_json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/}
  s=${s//$'\n'/\\n}
  printf '%s' "$s"
}

# ql_emit EVENT TEXT: print the hookSpecificOutput JSON Claude Code reads.
ql_emit() {
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' \
    "$1" "$(ql_json_escape "$2")"
}

# ql_session_id JSON: the session_id field, without needing jq.
ql_session_id() {
  printf '%s' "$1" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# ql_has TOOL: is TOOL on PATH? QL_HIDE_TOOLS (space-separated) lets the
# tests pretend a tool is missing.
ql_has() {
  case " ${QL_HIDE_TOOLS:-} " in *" $1 "*) return 1 ;; esac
  command -v "$1" >/dev/null 2>&1
}

# ql_mark_reported INPUT: remember that this session has been told about
# missing tools. Returns 1 if it had already been told.
ql_mark_reported() {
  local sid mark
  sid="$(ql_session_id "$1")"
  mark="$QL_STATE_DIR/missing-${sid:-nosession}"
  [ -f "$mark" ] && return 1
  mkdir -p "$QL_STATE_DIR" 2>/dev/null && : > "$mark" 2>/dev/null
  return 0
}

# ql_require HOOK EVENT INPUT TOOL...: return if every TOOL exists; else
# say which are missing (once per session) and exit 0.
ql_require() {
  local hook=$1 event=$2 input=$3 t
  shift 3
  local missing=()
  for t in "$@"; do ql_has "$t" || missing+=("$t"); done
  [ ${#missing[@]} -eq 0 ] && return 0
  if ql_mark_reported "$input"; then
    ql_emit "$event" "quest-log hook $hook could not run on this machine: missing ${missing[*]}. Install it so the quest-log check-ins work (needs bash, jq, curl, node)."
  fi
  exit 0
}
```

- [ ] **Step 4: Convert the five PostToolUse scripts**

In each, keep the existing header comment; replace everything after it as shown. (Use the Edit tool; the files are LF now but other files in this checkout are CRLF.)

`hooks/quest-log-checkin.sh` (keep the header and the `TRIGGER_PATTERN`/`REMINDER` lines; replace the last block):

```bash
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
input="$(cat)"
ql_require quest-log-checkin PostToolUse "$input" jq

cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"

if printf '%s' "$cmd" | grep -qE "$TRIGGER_PATTERN"; then
  ql_emit PostToolUse "$REMINDER"
fi
```

`hooks/quest-log-write-checkin.sh` (replace from `path=` to the end):

```bash
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
input="$(cat)"
ql_require quest-log-write-checkin PostToolUse "$input" jq

path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"

if printf '%s' "$path" | grep -qiE '(^|/)CLAUDE\.md$|memory'; then
  ql_emit PostToolUse 'Quest-log check-in: this file often documents scope, blockers, or decisions -- consider whether quest-log should reflect this change.'
fi
```

`hooks/quest-log-hierarchy-checkin.sh` (replace from `input=` to the end):

```bash
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
```

`hooks/quest-log-agent-checkin.sh` (replace from `input=` to the end):

```bash
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
input="$(cat)"
ql_require quest-log-agent-checkin PostToolUse "$input" jq

session_id="$(printf '%s' "$input" | jq -r '.session_id // empty')"
tool_name="$(printf '%s' "$input" | jq -r '.tool_name // empty')"

[ "$tool_name" = "Agent" ] || exit 0
[ -n "$session_id" ] || exit 0

state_dir="${TMPDIR:-/tmp}/quest-log-agent-checkin"
mkdir -p "$state_dir" 2>/dev/null || exit 0
count_file="$state_dir/$session_id"

count=0
[ -f "$count_file" ] && count="$(cat "$count_file" 2>/dev/null)"
case "$count" in ''|*[!0-9]*) count=0 ;; esac
count=$((count + 1))
printf '%s' "$count" > "$count_file" 2>/dev/null

if [ "$count" -ge 2 ]; then
  ql_emit PostToolUse "Quest-log check-in: this session has dispatched $count background agents now -- that usually means a real multi-source investigation, not a quick lookup. Is this tracked in quest-log yet (add_idea/set_quest_status), or just sitting in conversation?"
fi
```

`hooks/quest-log-halo-checkin.sh` (keep the `QUEST_LOG_URL=` line; replace from `pro_mode=` to the end):

```bash
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
```

Header comments: in every file under `hooks/` (including `quest-log-reminder.mjs`), replace mentions of `.claude/settings.json` with `hooks/hooks.json`, of `questtracker-skill.md` with `skills/quest-tracker/SKILL.md`, and any "no per-machine setup" / "everywhere it's checked out" wording with "on every machine with the quest-log plugin installed". Then confirm: `grep -rn "settings.json\|questtracker-skill\|per-machine setup\|checked out" hooks/` prints nothing.

- [ ] **Step 5: Run the tests**

Run: `node scripts/test-plugin-hooks.mjs` → Expected: all PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add hooks scripts/test-plugin-hooks.mjs
git commit -m "feat(hooks): say when a quest-log hook can't run, once per session (#142)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: One SessionStart message (preflight, version check, attention + stale nudges)

**Files:**
- Modify: `hooks/quest-log-session-start.sh` (full rewrite)
- Test: `scripts/test-plugin-hooks.mjs`

**Interfaces:**
- Consumes: `hooks/lib.sh` (`ql_emit`, `ql_has`, `ql_mark_reported`, `QL_STATE_DIR`) from Task 2; `.claude-plugin/plugin.json` `version` from Task 1; the server's `/health` `hooksVersion` (Task 4; the stub server supplies it in tests).
- Produces: the message texts later docs quote: "differs from the server's", "Update now:", "couldn't reach quest-log", "missing <tools>", "attention: true", "status: idea".

- [ ] **Step 1: Write the failing tests**

Insert above `// --- end ---`:

```js
// --- SessionStart (Task 3) ---
{
  const mine = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/plugin.json"), "utf8")).version;
  const run = (env) => runHook("quest-log-session-start.sh", { session_id: `t3-${Math.random()}` }, env);

  const same = await stubServer({ hooksVersion: mine });
  let r = await run({ QUEST_LOG_URL: `http://127.0.0.1:${same.address().port}/api/state` });
  let ctx = context(r.stdout);
  check("session-start: attention + stale nudges", ctx.includes("attention: true") && ctx.includes("status: idea"), r.stdout + r.stderr);
  check("session-start: quiet about versions when they match", !ctx.includes("Update now") && !ctx.includes("couldn't reach"), ctx);
  same.close();

  const newer = await stubServer({ hooksVersion: "99.0.0" });
  r = await run({ QUEST_LOG_URL: `http://127.0.0.1:${newer.address().port}/api/state` });
  ctx = context(r.stdout);
  check("session-start: tells a stale machine how to update",
    ctx.includes(`v${mine}`) && ctx.includes("v99.0.0") && ctx.includes("claude plugin update quest-log@quest-log"), ctx);
  newer.close();

  r = await run({ QUEST_LOG_URL: "http://127.0.0.1:9/api/state" });
  check("session-start: says when quest-log is unreachable", context(r.stdout).includes("couldn't reach quest-log"), r.stdout + r.stderr);

  r = await run({ QUEST_LOG_URL: "http://127.0.0.1:9/api/state", QL_HIDE_TOOLS: "jq node" });
  ctx = context(r.stdout);
  check("session-start: preflight names missing tools", ctx.includes("missing jq node"), r.stdout + r.stderr);
  check("session-start: still gives the standing nudges without jq", ctx.includes("attention: true"), ctx);
}
```

- [ ] **Step 2: Run and confirm they fail**

Run: `node scripts/test-plugin-hooks.mjs`
Expected: `FAIL  session-start: attention + stale nudges` (the old text has no "attention: true"), and the version/unreachable/preflight checks FAIL.

- [ ] **Step 3: Rewrite `hooks/quest-log-session-start.sh`**

```bash
#!/bin/bash
# SessionStart hook (#142): one message per session, in this order:
#   1. preflight: name any tool the hooks need that this machine lacks;
#   2. version check: compare this plugin's version with the hooksVersion
#      the quest-log server reports on /health, and give the exact update
#      commands on a mismatch (or say the server couldn't be reached);
#   3. the standing nudges: surface attention-flagged items, then review
#      stale "idea" items (nothing about the write-triggered hooks
#      re-surfaces old unread state on its own).
# Deliberately jq-free (sed + printf), so it still speaks when jq is the
# missing tool.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
QL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
input="$(cat)"
QUEST_LOG_URL="${QUEST_LOG_URL:-http://questlog.local/api/state}"
UPDATE_CMD='claude plugin marketplace update quest-log, then claude plugin update quest-log@quest-log, then restart Claude Code'
parts=()

# 1. preflight
missing=()
for t in jq curl node; do ql_has "$t" || missing+=("$t"); done
if [ ${#missing[@]} -gt 0 ]; then
  ql_mark_reported "$input"
  parts+=("quest-log hooks: missing ${missing[*]} on this machine, so some quest-log check-ins can't run. Install them.")
fi

# 2. version check
mine="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$QL_ROOT/.claude-plugin/plugin.json" | head -n 1)"
if ql_has curl; then
  health_url="${QUEST_LOG_URL%%/api/*}/health"
  health="$(curl -s -m 1.5 "$health_url" 2>/dev/null)"
  theirs="$(printf '%s' "$health" | sed -n 's/.*"hooksVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  if [ -z "$health" ]; then
    parts+=("quest-log hooks: couldn't reach quest-log at $health_url to check for hook updates (offline or off the home LAN?).")
  elif [ -n "$theirs" ] && [ "$theirs" != "$mine" ]; then
    parts+=("quest-log hooks on this machine are v$mine, which differs from the server's v$theirs. Update now: $UPDATE_CMD.")
  fi
fi

# 3. standing nudges
parts+=("Session started: early check -- call mcp__quest-log__list_quests(attention: true) and surface attention-flagged items to the user first; then review quest-log for items with status: idea that have not been touched recently and surface stale ones before this session progresses, especially if it touches quest-log-adjacent work (issues, PRs, memory, etc.).")

ql_emit SessionStart "$(printf '%s\n' "${parts[@]}")"
```

- [ ] **Step 4: Run the tests**

Run: `node scripts/test-plugin-hooks.mjs` → Expected: all PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add hooks/quest-log-session-start.sh scripts/test-plugin-hooks.mjs
git commit -m "feat(hooks): one SessionStart message with preflight, version check, attention + stale nudges (#142)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Server reports `hooksVersion` on `/health`

**Files:**
- Create: `app/hooks-version.js`, `scripts/test-hooks-version.mjs`
- Modify: `app/server.js:11-12,151`, `Dockerfile`, `package.json:3`

**Interfaces:**
- Produces: `readHooksVersion(rootDir: string): string | null` (`app/hooks-version.js`); `/health` → `{ status: "ok", version: "<package.json>", hooksVersion: "<plugin.json>" | null }`.

- [ ] **Step 1: Write the failing test**

`scripts/test-hooks-version.mjs`:

```js
// readHooksVersion (#142): the server reports the plugin (hooks) version on
// /health so each machine's SessionStart hook can tell it is out of date.
//   node scripts/test-hooks-version.mjs
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHooksVersion } from "../app/hooks-version.js";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

const root = mkdtempSync(join(tmpdir(), "ql-hv-"));
check("no plugin.json -> null", readHooksVersion(root) === null);
mkdirSync(join(root, ".claude-plugin"));
writeFileSync(join(root, ".claude-plugin", "plugin.json"), "{not json");
check("unreadable plugin.json -> null", readHooksVersion(root) === null);
writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "quest-log", version: "1.2.3" }));
check("reads the version", readHooksVersion(root) === "1.2.3", String(readHooksVersion(root)));
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
check("the repo's own manifest is readable", /^\d+\.\d+\.\d+$/.test(readHooksVersion(repo) ?? ""), String(readHooksVersion(repo)));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node scripts/test-hooks-version.mjs`
Expected: crash with `Cannot find module '.../app/hooks-version.js'`.

- [ ] **Step 3: Implement**

`app/hooks-version.js`:

```js
// The quest-log plugin's version (#142), read from .claude-plugin/plugin.json
// at the repo root. /health reports it as hooksVersion; each machine's
// SessionStart hook compares it with its own installed copy. Its own module
// (not inline in server.js) so it can be tested without starting the server.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function readHooksVersion(rootDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(rootDir, ".claude-plugin", "plugin.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}
```

`app/server.js`: after line 11 (`import { renderIndexHtml } from "./render.js";`) add

```js
import { readHooksVersion } from "./hooks-version.js";
```

after the `const __dirname = ...` line (line 14) add

```js
const HOOKS_VERSION = readHooksVersion(join(__dirname, ".."));
```

and change line 151 to

```js
app.get("/health", (_req, res) => res.json({ status: "ok", version: pkg.version, hooksVersion: HOOKS_VERSION }));
```

`Dockerfile`: after `COPY scripts ./scripts` add

```
COPY .claude-plugin ./.claude-plugin
```

`package.json`: `"version": "1.1.01"` → `"version": "1.2.00"` (MINOR: a new `/health` field).

- [ ] **Step 4: Run the tests**

Run: `node scripts/test-hooks-version.mjs` → Expected: 4 PASS, exit 0.
Run: `node scripts/test-plugin-hooks.mjs` → Expected: all PASS (unchanged).

- [ ] **Step 5: Commit**

```bash
git add app/hooks-version.js app/server.js Dockerfile package.json scripts/test-hooks-version.mjs
git commit -m "feat(server): report the plugin's hooksVersion on /health; 1.2.00 (#142)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Docs and instructions in the repo

**Files:**
- Modify: `CLAUDE.md` (MCP section's skill paragraph + "Auto-log reminder hook" + "Backstop check-in hooks" sections; "Deployment"), `README.md` (line 11; the UserPromptSubmit paragraph at lines 68-72; the "Backstop hooks" section at lines 80-117; "QuestTracker" at 272-277), `skills/quest-tracker/SKILL.md` ("Automated checkpoint reminders" section), `docs/questlog-family.svg` (lines 66-68, 2104, 2123, 2172), `questhelper/questhelper.js:816`, `state.js:405`

**Interfaces:**
- Consumes: the commands and message texts from Tasks 1-4 (quote them exactly).

- [ ] **Step 1: Write the failing check**

Insert above `// --- end ---` in `scripts/test-plugin-hooks.mjs`:

```js
// --- docs carry the install/update instructions and no stale claims (Task 5) ---
{
  const text = (p) => readFileSync(join(ROOT, p), "utf8");
  const claude = text("CLAUDE.md");
  check("CLAUDE.md: deploy step updates the local plugin",
    claude.includes("claude plugin update quest-log@quest-log") && /Last step of every deploy/.test(claude));
  check("CLAUDE.md: install command", claude.includes("claude plugin marketplace add hooptiej/quest-log"));
  for (const p of ["CLAUDE.md", "README.md", "skills/quest-tracker/SKILL.md", "questhelper/questhelper.js", "state.js"]) {
    const t = text(p);
    check(`${p}: no stale .claude/hooks paths`, !t.includes(".claude/hooks"));
    check(`${p}: no "no per-machine setup" claim`, !/no per-machine setup/i.test(t));
    check(`${p}: no questtracker-skill.md references`, !t.includes("questtracker-skill.md"));
  }
  check("diagram: no questtracker-skill.md", !text("docs/questlog-family.svg").includes("questtracker-skill.md"));
}
```

- [ ] **Step 2: Run and confirm it fails**

Run: `node scripts/test-plugin-hooks.mjs` → Expected: the Task 5 checks FAIL.

- [ ] **Step 3: CLAUDE.md**

Replace everything from the paragraph starting "`questtracker-skill.md` is a Claude Code skill (installed elsewhere as" through the end of the "### Backstop check-in hooks" section (the line before `## Build / run / test`) with:

```markdown
### The quest-log plugin: hooks + the QuestTracker skill (#142)

quest-log's Claude side ships as a **Claude Code plugin** from this repo (the repo is its own
marketplace): `.claude-plugin/plugin.json` + `marketplace.json`, the hooks in `hooks/`
(registered in `hooks/hooks.json`), and the QuestTracker skill in `skills/quest-tracker/SKILL.md`.
It is installed **per machine, at user scope**, so the hooks fire in every project, not only in
sessions opened inside this repo. (That was #142: they used to be registered in this repo's
`.claude/settings.json`, so they never ran where the real work happens.)

- **Install (once per machine):** `claude plugin marketplace add hooptiej/quest-log`, then
  `claude plugin install quest-log@quest-log`, then restart Claude Code.
- **Update:** `claude plugin marketplace update quest-log`, then
  `claude plugin update quest-log@quest-log`, then restart.
- **The MCP server entry is NOT in the plugin.** Each machine keeps its own `quest-log` entry in
  `~/.claude.json`, since machines can point at different quest-log servers. Hooks find the
  server through `QUEST_LOG_URL` (default `http://questlog.local/api/state`).
- **Hooks version:** `.claude-plugin/plugin.json` `version` (repeated in `marketplace.json`; the
  two must match). Bump it in any PR that changes `hooks/` or `skills/`, because
  `claude plugin update` only picks up a new version. It is separate from `package.json`'s server
  version. The server reports it as `hooksVersion` on `/health` (`app/hooks-version.js`; the
  Dockerfile copies `.claude-plugin/` in for this).
- **Never silent:** every hook exits 0 (a reminder must not block a tool call), but one that
  can't run says so once per session through `hooks/lib.sh` (`ql_require`), instead of the old
  `2>/dev/null || true`.
- **Checks:** `node scripts/test-plugin-hooks.mjs` (manifests, registrations, every hook against a
  stub server; needs bash and jq), `node scripts/test-hooks-version.mjs`, and
  `claude plugin validate .`.

The hooks (each injects a reminder as `additionalContext`; none call the MCP server):
- `quest-log-session-start.sh` (`SessionStart`): one message per session: a preflight naming any
  missing `jq`/`curl`/`node`; the version check against `/health` (on a mismatch it gives the exact
  update commands; if the server can't be reached it says so); then the standing nudges to check
  `list_quests(attention: true)` and to review stale `idea` items.
- `quest-log-reminder.mjs` (`UserPromptSubmit`): reminds the session to log a new concrete ask via
  `add_idea` before scoping it. Gated on `state._autoLog.enabled` (`set_auto_log`), read from
  `GET /api/state`, so the switch is machine-agnostic. A network error stays quiet (the
  SessionStart check already reports an unreachable server).
- `quest-log-checkin.sh` (`PostToolUse`/`Bash`): nudges on `git commit`/`push`, `gh pr
  merge`/`create`, `gh issue create`/`close`/`comment`, `docker build`/`run`/`restart`/`compose`.
- `quest-log-write-checkin.sh` (`PostToolUse`/`Write|Edit`): nudges on a `CLAUDE.md`/memory write.
- `quest-log-agent-checkin.sh` (`PostToolUse`/`Agent`): counts agent dispatches per session and
  nudges from the 2nd onward.
- `quest-log-hierarchy-checkin.sh` (`PostToolUse`/`mcp__.*__add_idea`, #108): nudges when a new
  Mission/Task has no parent.
- `quest-log-halo-checkin.sh` (`PostToolUse`/Halo MCP tools): ticket view/touch nudges, gated on
  `state._proMode` (`set_pro_mode`), so a no-op unless Pro Mode is on.

The skill also documents a direct REST fallback (`GET/POST /api/state` with the write token) for
when an MCP session is stale.
```

In `## Deployment`, after the `set_maintenance` paragraph (the section's last paragraph), add:

```markdown
**Last step of every deploy: the local plugin.** Deploys are always run by a Claude session (the
owner never deploys alone), so this step is part of the deploy, not a follow-up. If the release
changed `hooks/` or `skills/` (the version in `.claude-plugin/plugin.json` moved): on the machine
running the deploy, run `claude plugin marketplace update quest-log` and
`claude plugin update quest-log@quest-log`, restart Claude Code, and confirm the new session's
quest-log SessionStart message has no "differs from the server's" line. Check `/health` reports
the new `hooksVersion`. Every other machine is told at its next session start by that same check.
```

- [ ] **Step 4: README.md**

Line 11 → 

```markdown
- **`skills/quest-tracker/` + `hooks/`** — the `quest-log` Claude Code plugin: QuestTracker (the skill that keeps this quest log in sync with conversations) plus its check-in hooks; install once per machine (see "Claude Code plugin" below)
```

Delete the paragraph at lines 68-72 (starts "A checked-in `UserPromptSubmit` hook"). Replace the whole `### Backstop hooks: quest-log check-in` section (line 80 up to the line before `### Connecting over HTTPS`) with:

```markdown
### Claude Code plugin: QuestTracker + check-in hooks

This repo is also a Claude Code plugin marketplace. The `quest-log` plugin bundles the
QuestTracker skill (`skills/quest-tracker/SKILL.md`) and a set of small, additive hooks
(`hooks/`) that remind a Claude Code session to keep the quest log in sync at the moments that
usually matter: commits, PRs, issue changes, docker deploys, CLAUDE.md/memory edits, background
agents, parentless `add_idea` calls, new asks (gated on `set_auto_log`), Halo ticket work (Pro
Mode only), and session start.

Install it once per machine (user scope, so the hooks fire in every project):

    claude plugin marketplace add hooptiej/quest-log
    claude plugin install quest-log@quest-log

Update with `claude plugin marketplace update quest-log` then
`claude plugin update quest-log@quest-log`, and restart Claude Code. The MCP server is configured
separately (point your client at `/mcp`, above); the hooks find the server via `QUEST_LOG_URL`
(default `http://questlog.local/api/state`). The hooks need `bash`, `jq`, `curl` and `node`; the
session-start hook names any that are missing, and says when this machine's hooks differ from the
version the server reports on `/health` (`hooksVersion`).
```

Replace the `## QuestTracker` section body (lines 274-277) with:

```markdown
QuestTracker is the Claude Code skill that watches conversations for new ideas, work starting, or
things shipping/blocking, and keeps them in sync with this quest log via QuestHelper's MCP tools.
It ships in the `quest-log` plugin (`skills/quest-tracker/SKILL.md`, see "Claude Code plugin"
above), versioned here with the app and MCP code it depends on.
```

- [ ] **Step 5: The skill, the diagram, two code comments**

`skills/quest-tracker/SKILL.md`: replace the whole `## Automated checkpoint reminders (Claude Code hooks)` section (up to the line before `## Known limitation: stale MCP session after a quest-log redeploy`) with:

```markdown
## Automated checkpoint reminders (Claude Code hooks)

The instructions above rely on Claude noticing the right moments on its own. As a backstop, the
same `quest-log` plugin that ships this skill also ships hooks that inject a reminder at the
moments most likely to mean the quest log needs an update: on `git commit`/`push`, PR/issue
create-close-comment and docker build/restart/compose; on `CLAUDE.md`/memory writes; on session
start (attention-flagged items, stale ideas, and a check that this machine's hooks are current);
on the 2nd+ background-agent dispatch; on an `add_idea` that leaves a Mission/Task parentless; on
every user message (log a new ask first, gated on `set_auto_log`); and on Halo ticket tools (Pro
Mode only). quest-log's `CLAUDE.md` ("The quest-log plugin") is the canonical list.

The plugin is installed per machine, at user scope, so the hooks fire in every project. If a
session-start message says the hooks are missing or out of date, follow the command it gives
(`claude plugin marketplace update quest-log`, then `claude plugin update quest-log@quest-log`,
then restart) before other work. A hook can only inject text; it cannot call quest-log's MCP
tools, so the actual sync still has to come from Claude acting on the reminder.
```

`docs/questlog-family.svg`, text content only (keep every attribute):
- line 66 → `quest-log plugin (hooks/): installed`
- line 67 → `per machine at user scope, fires in`
- line 68 → `every project. See 04.`
- line 2104 → `The quest-log plugin's hooks/, installed per machine (user scope). These fire inside a Claude Code session and inject a text`
- line 2123 → `nudge; they never call the MCP server directly. Version-checked against /health at session start (#142).`
- line 2172 → `attention-flag nudge · stale-idea nudge · tools preflight · hooks version check (#142)`

`questhelper/questhelper.js:816`: in the `set_auto_log` description, `(.claude/hooks/)` → `(the quest-log plugin's hooks/)`.
`state.js:405`: `// (see .claude/hooks/) that reminds` → `// (see hooks/ in the quest-log plugin) that reminds`, and on the following lines change "without per-machine setup" to "on every machine with the plugin installed".

- [ ] **Step 6: Run the checks**

Run: `node scripts/test-plugin-hooks.mjs` → Expected: all PASS.
Run: `node scripts/test-adversarial-notes.mjs` and `node scripts/test-progress-archived.mjs` → Expected: still pass (no behaviour change; just confirms nothing broke).
Run: `git diff --stat main -- CLAUDE.md README.md state.js questhelper/questhelper.js` and confirm the counts are small (not whole-file rewrites; if they are, line endings broke, see Global Constraints).

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md README.md skills/quest-tracker/SKILL.md docs/questlog-family.svg questhelper/questhelper.js state.js scripts/test-plugin-hooks.mjs
git commit -m "docs: the quest-log plugin, its install/update commands and the deploy step (#142)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Live verification on this machine + the dev container, then the PR

**Files:** none (verification + PR). Do not run two agents against `quest-log-dev` at once.

- [ ] **Step 1: Push and deploy the branch to quest-log-dev**

```bash
git push -u origin plugin-hooks-142
ssh -i ~/.ssh/id_ed25519_truenas hoop@10.0.1.78 'cd "/mnt/Storage Pool/home/hoop/hoop/quest-log-dev" && git fetch -q origin && git checkout -q plugin-hooks-142 && git pull -q --no-rebase origin plugin-hooks-142 && sudo docker compose -f docker-compose.dev.yml up -d --build 2>&1 | tail -3 && sleep 5 && sudo docker logs --tail 5 quest-log-dev'
```

Expected: the container restarts; the log names the port it listens on (use it below).

- [ ] **Step 2: `/health` reports hooksVersion**

```bash
ssh -i ~/.ssh/id_ed25519_truenas hoop@10.0.1.78 'sudo docker exec quest-log-dev node -e "fetch(\"http://localhost:4242/health\").then(r=>r.text()).then(console.log)"'
curl -s http://questlog-dev.local/health
```

Expected: both print `{"status":"ok","version":"1.2.00","hooksVersion":"1.0.0"}` (use the port from Step 1's log if it isn't 4242).

- [ ] **Step 3: Install the plugin from the local checkout and prove it fires outside the repo**

```bash
claude plugin marketplace add "C:/Users/hoopt/Claude Code/quest-log"
claude plugin install quest-log@quest-log
cd "$TEMP" && QUEST_LOG_URL=http://questlog-dev.local/api/state claude -p "Quote word for word any text in your context that starts with 'Session started' or 'quest-log hooks'. Reply NONE if there is none."
```

Expected: the reply quotes the "Session started: early check -- call mcp__quest-log__list_quests(attention: true)..." line, from a folder that is not the quest-log repo. Then the PostToolUse path:

```bash
cd "$TEMP" && claude -p --allowedTools Bash "Run this exact command with the Bash tool: echo 'git commit dry run'. Then quote word for word any 'Quest-log check-in' reminder you received after it, or reply NONE."
```

Expected: the reply quotes "Quest-log check-in: does this completion belong in the quest log...".

- [ ] **Step 4: The version mismatch path, live**

```bash
cd "$TEMP" && QUEST_LOG_URL=http://127.0.0.1:9/api/state claude -p "Quote word for word any text in your context that starts with 'quest-log hooks'. Reply NONE if there is none."
```

Expected: quotes "quest-log hooks: couldn't reach quest-log at http://127.0.0.1:9/health ...". The mismatch text is covered by the Task 3 unit test against a stub server (the spec's "bumped server-side hooksVersion on dev" variant is replaced by that, since bumping dev's version would mean editing the deployed checkout).

- [ ] **Step 5: Remove the local-path install** (the real install comes from GitHub after merge)

```bash
claude plugin uninstall quest-log@quest-log
claude plugin marketplace remove quest-log
```

- [ ] **Step 6: Open the PR, bind it, ask to merge**

```bash
gh pr create -R hooptiej/quest-log --head plugin-hooks-142 --title "The smoke detectors move into every room: quest-log's hooks ship as a plugin (#142)" --body "Closes #142. Implements docs/superpowers/specs/2026-10-10-quest-log-plugin-design.md per docs/superpowers/plans/2026-10-10-quest-log-plugin.md. <summary of tasks 1-5 and the live checks from this task, with their actual output>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Call `mcp__ccd_pr__get_status` (bind with `mcp__ccd_pr__bind_pr` if it doesn't report the PR). Ask the owner to merge with the button panel. Merge with `mcp__github__merge_pull_request` (not `gh pr merge`), then delete the branch.

---

### Task 7: Rollout after merge (prod, this machine, the other machines)

Only after the owner says to merge and deploy.

- [ ] **Step 1: Deploy prod**

`mcp__quest-log__set_maintenance(active: true, note: "1.2.00: hooks become a plugin (#142)")`, then:

```bash
ssh -i ~/.ssh/id_ed25519_truenas hoop@10.0.1.78 'cd "/mnt/Storage Pool/home/hoop/hoop/quest-log" && git pull -q --no-rebase && sudo docker compose up -d --build 2>&1 | tail -3'
curl -s http://questlog.local/health
```

Expected: `{"status":"ok","version":"1.2.00","hooksVersion":"1.0.0"}`. Then `set_maintenance(active: false)` (from a fresh session if this one's MCP session dropped).

- [ ] **Step 2: Install from GitHub on this machine (the new deploy step, run for real)**

```bash
claude plugin marketplace add hooptiej/quest-log
claude plugin install quest-log@quest-log
cd "$TEMP" && claude -p "Quote word for word any text in your context that starts with 'Session started' or 'quest-log hooks'. Reply NONE if there is none."
```

Expected: the "Session started" line, and no "differs from the server's" line.

- [ ] **Step 3: Retire the machine-local copies (in `~/.claude`, the claude-config repo)**

- `git -C ~/.claude rm -r -q skills/quest-tracker` (the plugin carries the skill now).
- In `~/.claude/settings.json`, delete the whole `"SessionStart"` entry (the one-line attention echo); the plugin's SessionStart hook now says it. If `hooks` is then empty, delete the `hooks` key.
- In `~/.claude/CLAUDE.md`, under "MCP servers configured", after the `quest-log` bullet add:

```markdown
  - Its **hooks and the quest-tracker skill come from the `quest-log` Claude Code plugin**, installed per machine at user scope: `claude plugin marketplace add hooptiej/quest-log`, then `claude plugin install quest-log@quest-log`, then restart. If a session-start message says the quest-log hooks are missing or out of date, install or update the plugin before other work. The MCP server entry itself stays in `~/.claude.json` (it is not in the plugin).
```

Commit in `~/.claude` (message "quest-log hooks + skill now come from the quest-log plugin (hooptiej/quest-log#142)"); ask the owner before `git push` (claude-config pushes are on request).

- [ ] **Step 4: Tell the other machines**

The Mac and work sessions still have the old attention echo until they pull claude-config, so it will make them check attention-flagged items. Append to the "quest-log hooks only fire inside the quest-log repo" quest's notes:

```
=== QUESTION FROM Windows desktop session, 2026-10-10 ===
quest-log's hooks + skill are now a plugin (hooptiej/quest-log#142). On this machine: `git -C ~/.claude pull`, then `claude plugin marketplace add hooptiej/quest-log` and `claude plugin install quest-log@quest-log`, restart, and confirm a new session shows the "Session started" quest-log line. Reply here when done and clear the attention flag.
```

and `set_attention(true)` on it. Mark the quest `done` only once every machine has replied.

- [ ] **Step 5: Close out**

Confirm #142 closed via the PR. `add_log_entry`: "quest-log 1.2.00: hooks + QuestTracker skill ship as the quest-log plugin, installed per machine; deploy step and version check added (#142)."
