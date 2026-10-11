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
