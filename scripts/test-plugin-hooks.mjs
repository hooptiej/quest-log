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
  return runBash([join(HOOKS, script).replace(/\\/g, "/")], input, env);
}

// Run a hooks.json command string the way Claude Code does: bash -c "<command>".
function runCommand(command, input, env = {}) {
  return runBash(["-c", command], input, env);
}

function runBash(args, input, env) {
  return new Promise((resolve) => {
    const child = spawn(BASH, args, {
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

// A tiny stand-in quest-log: GET /health and GET /api/state. server.flags
// can be changed between runs; server.hits counts requests per path.
// omitFlags mimics a server from before #143 (/health without the switches).
function stubServer({ hooksVersion, proMode = false, autoLog = false, omitFlags = false }) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      const { autoLog, proMode } = server.flags;
      if (req.url === "/health") {
        server.hits.health++;
        const flags = omitFlags ? {} : { autoLog, proMode };
        res.end(JSON.stringify({ status: "ok", version: "0.0.0", hooksVersion, ...flags }));
      } else {
        server.hits.state++;
        res.end(JSON.stringify({ quests: [], _autoLog: { enabled: autoLog }, _proMode: proMode }));
      }
    });
    server.flags = { autoLog, proMode };
    server.hits = { health: 0, state: 0 };
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}
const totalHits = (server) => server.hits.health + server.hits.state;

// The reminder text quest-log-reminder prints when auto-log is on.
const REMINDER =
  "If the message just submitted is a new concrete ask (a bug, a feature, a multi-part " +
  "request), log it into quest-log via add_idea now, with enough detail in the notes to " +
  "stand alone -- before scoping or starting the implementation. Skip this reminder if the " +
  "message isn't a new ask (a question, an answer to something already asked, small talk, " +
  "a reply mid-task, etc.).";

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

  r = await run({ QUEST_LOG_URL: "http://127.0.0.1:9/api/state", QL_HIDE_TOOLS: "jq" });
  ctx = context(r.stdout);
  check("session-start: preflight names missing tools", ctx.includes("missing jq ") && r.code === 0, r.stdout + r.stderr);
  check("session-start: still gives the standing nudges without jq", ctx.includes("attention: true"), ctx);

  // An old server whose /health has no hooksVersion: say nothing about versions.
  const old = await stubServer({});
  r = await run({ QUEST_LOG_URL: `http://127.0.0.1:${old.address().port}/api/state` });
  ctx = context(r.stdout);
  check("session-start: quiet about versions on a server without hooksVersion",
    ctx.includes("attention: true") && !ctx.includes("Update now") && !ctx.includes("couldn't reach") && r.code === 0, r.stdout + r.stderr);
  old.close();
}

// --- the auto-log / Pro Mode switches come from a 1-minute per-session cache (#143) ---
{
  const sid = (tag) => `t143-${tag}-${Math.random()}`;
  const urlOf = (server) => `http://127.0.0.1:${server.address().port}/api/state`;
  const reminder = (session_id, env) => runHook("quest-log-reminder.sh", { session_id, prompt: "x" }, env);
  const cacheFile = (session_id) => join(TMP, "quest-log-hooks", `flags-${session_id}`);

  check("reminder is a bash script now", existsSync(join(HOOKS, "quest-log-reminder.sh")) && !existsSync(join(HOOKS, "quest-log-reminder.mjs")));
  const hooksJson = JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8"));
  const ups = hooksJson.hooks.UserPromptSubmit?.[0]?.hooks?.[0] ?? {};
  check("UserPromptSubmit runs the bash reminder",
    ups.command === 'bash "${CLAUDE_PLUGIN_ROOT}/hooks/quest-log-reminder.sh"' && ups.shell === "bash", JSON.stringify(ups));

  // SessionStart seeds the cache; the next prompt in that session asks nothing.
  const on = await stubServer({ hooksVersion: "1.0.0", autoLog: true });
  let s = sid("seed");
  let r = await runHook("quest-log-session-start.sh", { session_id: s }, { QUEST_LOG_URL: urlOf(on) });
  check("cache: session-start exits 0", r.code === 0, r.stderr);
  check("cache: session-start fetched /health once", on.hits.health === 1 && on.hits.state === 0, JSON.stringify(on.hits));
  let before = totalHits(on);
  r = await reminder(s, { QUEST_LOG_URL: urlOf(on) });
  check("cache: reminder after session-start prints the reminder", r.stdout === REMINDER && r.code === 0, r.stdout + r.stderr);
  check("cache: reminder after session-start makes 0 requests", totalHits(on) === before, JSON.stringify(on.hits));

  // New session, no cache: one /health request, then none within the TTL.
  s = sid("fresh");
  const { health: h0, state: s0 } = on.hits;
  r = await reminder(s, { QUEST_LOG_URL: urlOf(on) });
  check("cache: first prompt of a new session fetches /health once",
    r.stdout === REMINDER && r.code === 0 && on.hits.health === h0 + 1 && on.hits.state === s0, JSON.stringify(on.hits));
  before = totalHits(on);
  r = await reminder(s, { QUEST_LOG_URL: urlOf(on) });
  check("cache: second prompt within the TTL makes 0 requests", r.stdout === REMINDER && r.code === 0 && totalHits(on) === before, JSON.stringify(on.hits));

  // TTL expiry: refetch, and follow a switch flipped on the server.
  s = sid("ttl");
  r = await reminder(s, { QUEST_LOG_URL: urlOf(on), QL_FLAGS_TTL: "0" });
  check("ttl: on -> reminder", r.stdout === REMINDER && r.code === 0, r.stdout + r.stderr);
  on.flags.autoLog = false;
  before = on.hits.health;
  r = await reminder(s, { QUEST_LOG_URL: urlOf(on), QL_FLAGS_TTL: "0" });
  check("ttl: expired cache refetches and follows the flip to off", r.stdout === "" && r.code === 0 && on.hits.health === before + 1, r.stdout + JSON.stringify(on.hits));
  on.flags.autoLog = true;
  r = await reminder(s, { QUEST_LOG_URL: urlOf(on), QL_FLAGS_TTL: "0" });
  check("ttl: and back on", r.stdout === REMINDER && r.code === 0, r.stdout + r.stderr);
  on.close();

  // autoLog off: silent.
  const off = await stubServer({ hooksVersion: "1.0.0", autoLog: false });
  r = await reminder(sid("off"), { QUEST_LOG_URL: urlOf(off) });
  check("cache: auto-log off -> reminder silent", r.stdout === "" && r.code === 0, r.stdout + r.stderr);
  off.close();

  // Unreachable: silent, remembered, and the next prompt doesn't wait again.
  s = sid("down");
  const down = { QUEST_LOG_URL: "http://127.0.0.1:9/api/state" };
  r = await reminder(s, down);
  const cached = existsSync(cacheFile(s)) ? readFileSync(cacheFile(s), "utf8") : "";
  check("unreachable: first prompt silent", r.stdout === "" && r.code === 0, r.stdout + r.stderr);
  check("unreachable: caches reachable=0", /^reachable=0$/m.test(cached) && /^fetched_at=\d+$/m.test(cached), cached);
  const t0 = Date.now();
  r = await reminder(s, down);
  const ms = Date.now() - t0;
  check(`unreachable: second prompt is fast (${ms} ms < 700) and silent`, ms < 700 && r.stdout === "" && r.code === 0, r.stdout + r.stderr);

  // A server from before #143: fall back to /api/state once, then cache.
  const old = await stubServer({ hooksVersion: "1.0.0", autoLog: true, omitFlags: true });
  s = sid("old");
  r = await reminder(s, { QUEST_LOG_URL: urlOf(old) });
  check("old server: falls back to /api/state and honors _autoLog.enabled",
    r.stdout === REMINDER && r.code === 0 && old.hits.state === 1, r.stdout + r.stderr + JSON.stringify(old.hits));
  before = totalHits(old);
  r = await reminder(s, { QUEST_LOG_URL: urlOf(old) });
  check("old server: second prompt within the TTL makes 0 requests", r.stdout === REMINDER && r.code === 0 && totalHits(old) === before, JSON.stringify(old.hits));
  old.close();

  // Halo reads Pro Mode from /health, never the full state.
  const pro = await stubServer({ hooksVersion: "1.0.0", proMode: true });
  r = await runHook("quest-log-halo-checkin.sh", { session_id: sid("halo"), tool_name: "mcp__halo__halopsa_tickets_get" }, { QUEST_LOG_URL: urlOf(pro) });
  check("halo: view nudge from the cached Pro Mode flag", context(r.stdout).includes("log_ticket_view") && r.code === 0, r.stdout + r.stderr);
  check("halo: 0 /api/state requests", pro.hits.state === 0, JSON.stringify(pro.hits));
  pro.close();

  // node is no longer a hook requirement.
  r = await runHook("quest-log-session-start.sh", { session_id: sid("nonode") }, { ...down, QL_HIDE_TOOLS: "node" });
  check("preflight: node isn't required", !context(r.stdout).includes("missing") && r.code === 0, r.stdout + r.stderr);
}

// --- every registered command runs as Claude Code runs it (bash -c, Windows-style root) ---
{
  const hooksJson = JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8"));
  const mine = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/plugin.json"), "utf8")).version;
  const server = await stubServer({ hooksVersion: mine });
  const env = { CLAUDE_PLUGIN_ROOT: ROOT, QUEST_LOG_URL: `http://127.0.0.1:${server.address().port}/api/state` };
  const commands = Object.values(hooksJson.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
  for (const c of commands) {
    const r = await runCommand(c, { session_id: `t-cmd-${Math.random()}`, tool_name: "x", tool_input: {} }, env);
    let ok = r.code === 0;
    // The UserPromptSubmit reminder prints plain text; the rest print JSON.
    if (ok && !c.includes("quest-log-reminder") && r.stdout.trim()) {
      try { ok = !!JSON.parse(r.stdout).hookSpecificOutput; } catch { ok = false; }
    }
    check(`registered command runs: ${c}`, ok, `code ${r.code}: ${r.stdout}${r.stderr}`);
  }
  server.close();
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
