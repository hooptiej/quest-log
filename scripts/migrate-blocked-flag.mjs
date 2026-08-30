#!/usr/bin/env node
// One-off migration for #26: "blocked" stops being a status value and
// becomes an independent flag. Any quest with status === "blocked" becomes
// status: "progress", blocked: true (in current prod data, that's exactly
// nvr-recording). Nothing else changes.
//
// Usage: node scripts/migrate-blocked-flag.mjs [path-to-state.json]
// Defaults to ./data/state.json. Safe to run more than once -- a quest that
// isn't status: "blocked" is left untouched.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const path = process.argv[2] ?? fileURLToPath(new URL("../data/state.json", import.meta.url));

const raw = await readFile(path, "utf8");
const state = JSON.parse(raw);

let migrated = 0;
for (const q of state.quests) {
  if (q.status !== "blocked") continue;
  q.status = "progress";
  q.blocked = true;
  migrated++;
}

if (migrated === 0) {
  console.log(`Nothing to migrate -- no quest in ${path} has status: "blocked".`);
  process.exit(0);
}

await writeFile(path, JSON.stringify(state, null, 2));
console.log(`Migrated ${migrated} quest(s) in ${path} from status: "blocked" to status: "progress", blocked: true.`);
