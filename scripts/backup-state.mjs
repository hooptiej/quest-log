#!/usr/bin/env node
// Snapshots the live state file (DATA_PATH, or ./data/state.json) to
// data/backups/state-<timestamp>.json. Read-only against the source --
// safe to run any time, whether or not the server is up.
//
// Usage: node scripts/backup-state.mjs [source-path] [--out <dir>]
// Defaults: source is DATA_PATH env var, or ./data/state.json (matching
// how the app itself resolves it); backups land in a "backups" directory
// next to the source unless --out overrides it.
//
// Exported for reuse by import-state.mjs, which backs up the current
// target before overwriting it.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export async function backupState(sourcePath, outDir) {
  const resolvedSource = resolve(sourcePath);
  const backupsDir = resolve(outDir ?? join(dirname(resolvedSource), "backups"));

  const raw = await readFile(resolvedSource, "utf8");
  JSON.parse(raw); // fail loudly on invalid JSON before writing anything

  await mkdir(backupsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupsDir, `state-${timestamp}.json`);
  await writeFile(backupPath, raw);
  return backupPath;
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outDir = outIdx !== -1 ? args[outIdx + 1] : undefined;
  const positional = args.filter((_, i) => i !== outIdx && i !== outIdx + 1);

  const defaultSource = process.env.DATA_PATH ?? fileURLToPath(new URL("../data/state.json", import.meta.url));
  const sourcePath = resolve(positional[0] ?? defaultSource);

  const backupPath = await backupState(sourcePath, outDir);
  console.log(`Backed up ${sourcePath} -> ${backupPath}`);
}

// Only run as a CLI when invoked directly -- import-state.mjs imports
// backupState() above without triggering this.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
