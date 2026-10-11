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
