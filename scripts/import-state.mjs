#!/usr/bin/env node
// Imports a state.json snapshot (e.g. one made by backup-state.mjs, or a
// copy pulled from another deployment) into the live data file. Validates
// the snapshot's shape first and refuses anything invalid; backs up
// whatever is currently at the target before overwriting it, so an import
// is always reversible.
//
// Usage: node scripts/import-state.mjs <path-to-snapshot> [target-path]
// Defaults: target is DATA_PATH env var, or ./data/state.json.
import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { validateState } from "../state.js";
import { backupState } from "./backup-state.mjs";

async function main() {
  const [snapshotArg, targetArg] = process.argv.slice(2);
  if (!snapshotArg) {
    throw new Error("Usage: node scripts/import-state.mjs <path-to-snapshot> [target-path]");
  }

  const defaultTarget = process.env.DATA_PATH ?? fileURLToPath(new URL("../data/state.json", import.meta.url));
  const snapshotPath = resolve(snapshotArg);
  const targetPath = resolve(targetArg ?? defaultTarget);

  const snapshotRaw = await readFile(snapshotPath, "utf8");
  const snapshot = JSON.parse(snapshotRaw);

  const error = validateState(snapshot);
  if (error) {
    throw new Error(`Refusing to import ${snapshotPath} into ${targetPath}: ${error}`);
  }

  const currentRaw = await readFile(targetPath, "utf8").catch(() => null);
  const current = currentRaw ? JSON.parse(currentRaw) : { quests: [], log: [] };

  let backupPath = null;
  if (currentRaw) {
    backupPath = await backupState(targetPath);
  }

  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, snapshotRaw);
  await rename(tmpPath, targetPath);

  console.log(
    `Imported ${snapshotPath} -> ${targetPath}` +
      (backupPath ? ` (previous state backed up to ${backupPath})` : " (no prior state file to back up)") +
      `.\nQuests: ${current.quests.length} -> ${snapshot.quests.length}. ` +
      `Log entries: ${current.log.length} -> ${snapshot.log.length}.`,
  );
}

await main();
