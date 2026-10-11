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
