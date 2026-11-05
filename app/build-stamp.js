// The build stamp (#156): which build of quest-log is running. It is the git
// short sha plus the build date. The Docker image bakes both into
// build-stamp.json at the repo root (see the Dockerfile's BUILD_SHA and
// BUILD_DATE args). A plain checkout has no such file, so it falls back to
// `git rev-parse --short HEAD`. This is the one place the stamp is resolved:
// server.js calls it once at startup, and /health and the page footer read
// the result. It never throws. A missing file, a bad file or a missing git
// gives "unknown" (or the git sha alone), never a crash or a blank footer.
// Its own module so it can be tested without starting the server; see
// scripts/test-build-stamp.mjs.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export const STAMP_FILE = "build-stamp.json";
const SHA_RE = /^[0-9a-f]{4,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The baked file, written by the Dockerfile:
//   {"build":"a1b2c3d","built_at":"2026-11-05"}
// Returns null when the file is absent or unusable, so the caller falls back.
export function readBakedStamp(rootDir) {
  try {
    const raw = JSON.parse(readFileSync(join(rootDir, STAMP_FILE), "utf8"));
    if (!raw || typeof raw !== "object" || typeof raw.build !== "string" || !SHA_RE.test(raw.build)) return null;
    const builtAt = typeof raw.built_at === "string" && DATE_RE.test(raw.built_at) ? raw.built_at : null;
    return { source: "image", build: raw.build, built_at: builtAt };
  } catch {
    return null;
  }
}

// The git short sha of the checkout, or null when git or the repo is missing.
export function gitShortSha(rootDir) {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
      windowsHide: true,
    }).trim();
    return SHA_RE.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

// { source, build, built_at }:
//   source "image"    - baked by the Docker build; build = sha, built_at = date
//   source "checkout" - no baked file; build = git sha, built_at = null
//   source "unknown"  - neither; build = "unknown", built_at = null
export function resolveBuildStamp(rootDir) {
  const baked = readBakedStamp(rootDir);
  if (baked) return baked;
  const sha = gitShortSha(rootDir);
  if (sha) return { source: "checkout", build: sha, built_at: null };
  return { source: "unknown", build: "unknown", built_at: null };
}

// The human line for the footer, after the version:
//   "build a1b2c3d (2026-11-05)"  baked image
//   "build source a1b2c3d"        plain checkout
//   "build source unknown"        no git and no baked file
export function formatBuildLine(stamp) {
  if (stamp.source === "image") return `build ${stamp.build} (${stamp.built_at ?? "date unknown"})`;
  return `build source ${stamp.build}`;
}
