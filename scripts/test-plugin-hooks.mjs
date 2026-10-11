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

// --- PostToolUse hooks (Task 2) ---
{
  const sid = `t2-${Date.now()}`;
  let r = await runHook("quest-log-checkin.sh", { session_id: sid, tool_input: { command: "git commit -m x" } });
  check("checkin: fires on git commit", context(r.stdout).startsWith("Quest-log check-in") && r.code === 0, r.stdout + r.stderr);
  r = await runHook("quest-log-checkin.sh", { session_id: sid, tool_input: { command: "ls -la" } });
  check("checkin: quiet on ls", r.stdout.trim() === "" && r.code === 0, r.stdout + r.stderr);
  r = await runHook("quest-log-write-checkin.sh", { session_id: sid, tool_input: { file_path: "C:/x/CLAUDE.md" } });
  check("write-checkin: fires on CLAUDE.md", context(r.stdout).includes("quest-log") && r.code === 0, r.stdout + r.stderr);
  r = await runHook("quest-log-write-checkin.sh", { session_id: sid, tool_input: { file_path: "src/app.js" } });
  check("write-checkin: quiet on app.js", r.stdout.trim() === "" && r.code === 0, r.stdout);
  r = await runHook("quest-log-hierarchy-checkin.sh", { session_id: sid, tool_name: "mcp__quest-log__add_idea", tool_input: { title: "x" } });
  check("hierarchy: fires on a parentless mission", context(r.stdout).includes("no parent") && r.code === 0, r.stdout + r.stderr);
  r = await runHook("quest-log-hierarchy-checkin.sh", { session_id: sid, tool_name: "mcp__quest-log__add_idea", tool_input: { title: "x", parentIdOrTitle: "p" } });
  check("hierarchy: quiet with a parent", r.stdout.trim() === "" && r.code === 0, r.stdout);
  r = await runHook("quest-log-agent-checkin.sh", { session_id: sid, tool_name: "Agent" });
  check("agent: quiet on the first dispatch", r.stdout.trim() === "" && r.code === 0, r.stdout);
  r = await runHook("quest-log-agent-checkin.sh", { session_id: sid, tool_name: "Agent" });
  check("agent: nudges on the second dispatch", context(r.stdout).includes("2 background agents") && r.code === 0, r.stdout + r.stderr);

  const halo = await stubServer({ hooksVersion: "1.0.0", proMode: true });
  const url = `http://127.0.0.1:${halo.address().port}/api/state`;
  r = await runHook("quest-log-halo-checkin.sh", { session_id: sid, tool_name: "mcp__halo__halopsa_tickets_get" }, { QUEST_LOG_URL: url });
  check("halo: view nudge when Pro Mode is on", context(r.stdout).includes("log_ticket_view") && r.code === 0, r.stdout + r.stderr);
  halo.close();

  // A machine without jq: say so once per session, then stay quiet.
  const sid2 = `t2-nojq-${Date.now()}`;
  r = await runHook("quest-log-checkin.sh", { session_id: sid2, tool_input: { command: "git push" } }, { QL_HIDE_TOOLS: "jq" });
  check("missing jq: named once", context(r.stdout).includes("missing jq") && r.code === 0, r.stdout + r.stderr);
  r = await runHook("quest-log-write-checkin.sh", { session_id: sid2, tool_input: { file_path: "CLAUDE.md" } }, { QL_HIDE_TOOLS: "jq" });
  check("missing jq: not repeated in the same session", r.stdout.trim() === "" && r.code === 0, r.stdout);
}

// --- SessionStart (Task 3) ---
{
  const mine = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/plugin.json"), "utf8")).version;
  const run = (env) => runHook("quest-log-session-start.sh", { session_id: `t3-${Math.random()}` }, env);

  const same = await stubServer({ hooksVersion: mine });
  let r = await run({ QUEST_LOG_URL: `http://127.0.0.1:${same.address().port}/api/state` });
  let ctx = context(r.stdout);
  check("session-start: attention + stale nudges", ctx.includes("attention: true") && ctx.includes("status: idea") && r.code === 0, r.stdout + r.stderr);
  check("session-start: quiet about versions when they match", !ctx.includes("Update now") && !ctx.includes("couldn't reach"), ctx);
  same.close();

  const newer = await stubServer({ hooksVersion: "99.0.0" });
  r = await run({ QUEST_LOG_URL: `http://127.0.0.1:${newer.address().port}/api/state` });
  ctx = context(r.stdout);
  check("session-start: tells a stale machine how to update",
    ctx.includes(`v${mine}`) && ctx.includes("v99.0.0") && ctx.includes("claude plugin update quest-log@quest-log") && r.code === 0, ctx);
  newer.close();

  r = await run({ QUEST_LOG_URL: "http://127.0.0.1:9/api/state" });
  check("session-start: says when quest-log is unreachable", context(r.stdout).includes("couldn't reach quest-log") && r.code === 0, r.stdout + r.stderr);

  r = await run({ QUEST_LOG_URL: "http://127.0.0.1:9/api/state", QL_HIDE_TOOLS: "jq node" });
  ctx = context(r.stdout);
  check("session-start: preflight names missing tools", ctx.includes("missing jq node") && r.code === 0, r.stdout + r.stderr);
  check("session-start: still gives the standing nudges without jq", ctx.includes("attention: true"), ctx);
}

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

// --- end ---
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
