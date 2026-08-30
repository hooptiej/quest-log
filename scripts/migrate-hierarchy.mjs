#!/usr/bin/env node
// One-off migration for #12: adds level/parentId to every quest that
// predates the Quest -> Mission -> Task hierarchy. Existing flat items all
// become ungrouped missions (level: "mission", parentId: null), per the
// migration plan agreed on the issue -- nothing is re-parented automatically.
//
// Usage: node scripts/migrate-hierarchy.mjs [path-to-state.json]
// Defaults to ./data/state.json. Safe to run more than once -- an item
// that already has a level is left untouched.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const path = process.argv[2] ?? fileURLToPath(new URL("../data/state.json", import.meta.url));

const raw = await readFile(path, "utf8");
const state = JSON.parse(raw);

let migrated = 0;
for (const q of state.quests) {
  if (q.level) continue;
  q.level = "mission";
  q.parentId = null;
  migrated++;
}

if (migrated === 0) {
  console.log(`Nothing to migrate -- every quest in ${path} already has a level.`);
  process.exit(0);
}

await writeFile(path, JSON.stringify(state, null, 2));
console.log(`Migrated ${migrated} quest(s) in ${path} to level: "mission", parentId: null.`);
