// The monthly sweep (#153) against a throwaway git fixture: a bare "origin"
// with trunk plus one branch that has no PR, a clone with one stash and one
// stray directory under .claude/worktrees that git does not know about. Runs
// with --no-gh --no-ssh, so it needs git on PATH and nothing else; no network.
//   node scripts/test-monthly-sweep.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SWEEP = fileURLToPath(new URL("./monthly-sweep.mjs", import.meta.url));
const ORPHAN = "orphan-branch-no-pr-7f3a";
const STRAY = "stray-worktree-dir-9c1e";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.error) throw new Error(`${cmd} ${args.join(" ")}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}
// identity flags so the fixture commits work on a machine with no git config
const G = ["-c", "user.name=sweep-test", "-c", "user.email=sweep-test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"];
const git = (cwd, ...args) => sh("git", [...G, ...args], cwd);

function buildFixture(root) {
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  const work = join(root, "work"); // the checkout the sweep finds
  sh("git", ["init", "--bare", "-b", "main", bare]);
  sh("git", ["init", "-b", "main", seed]);
  writeFileSync(join(seed, "README.md"), "fixture\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "trunk");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "-q", "origin", "main");
  // a branch on origin with a commit of its own and no PR anywhere
  git(seed, "checkout", "-q", "-b", ORPHAN);
  writeFileSync(join(seed, "orphan.txt"), "left behind\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "orphan work");
  git(seed, "push", "-q", "origin", ORPHAN);
  rmSync(seed, { recursive: true, force: true });
  // the checkout under test: a clone (so origin/HEAD exists), plus one stash
  // and one stray worktree directory
  sh("git", [...G, "clone", "-q", bare, work]);
  writeFileSync(join(work, "README.md"), "fixture, edited\n");
  git(work, "stash", "push", "-q", "-m", "fixture stash");
  mkdirSync(join(work, ".claude", "worktrees", STRAY), { recursive: true });
  writeFileSync(join(work, ".claude", "worktrees", STRAY, "leftover.txt"), "git never registered this\n");
  return work;
}

function runSweep(args) {
  const r = spawnSync(process.execPath, [SWEEP, ...args], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const root = mkdtempSync(join(tmpdir(), "monthly-sweep-fixture-"));
try {
  const work = buildFixture(root);
  const before = git(work, "status", "--porcelain"); // the stray dir is untracked, and that is the fixture's doing

  const md = runSweep(["--root", root, "--no-gh", "--no-ssh"]);
  check("exit 0 on the fixture", md.code === 0, `exit ${md.code}; stderr: ${md.err.slice(0, 400)}`);
  check("report has a section for the checkout", md.out.includes("## work"), md.out.slice(0, 300));
  check("report names the PR-less branch", md.out.includes(`\`${ORPHAN}\``), "branch missing from report");
  check("PR-less branch shows its commits ahead of trunk", /orphan-branch-no-pr-7f3a` — 1 ahead of main; last commit \d{4}-\d{2}-\d{2}/.test(md.out), md.out.match(/.*orphan-branch.*/)?.[0]);
  check("report names the stray worktree directory", md.out.includes(STRAY) && md.out.includes("STRAY"), "stray dir missing from report");
  check("report counts the stash", md.out.includes("- Stashes: 1"), md.out.match(/.*Stashes.*/)?.[0]);
  check("PR state is 'not captured: --no-gh', never blank", md.out.includes("PR state not captured") && md.out.includes("not captured: --no-gh"), "");
  check("prod version says why it was not captured", /Prod version: not captured: .*no CLAUDE\.md/.test(md.out), md.out.match(/.*Prod version.*/)?.[0]);
  check("snapshot table has the fixed columns in order", md.out.includes("| project | prod version | rollback tag | open PRs | open issues | stranger-installable | note |"), "");
  check("stranger-installable is left to the skill", /\| work \|.*\| not assessed \|/.test(md.out), md.out.match(/\| work \|.*/)?.[0]);
  check("note column names stash, branch and stray dir", /\| work \|.*1 stash.*1 remote branch.*1 stray dir/.test(md.out), md.out.match(/\| work \|.*/)?.[0]);
  check("nothing was written into the fixture by the sweep", git(work, "status", "--porcelain") === before && git(work, "stash", "list").split("\n").length === 1, "working tree or stash list changed");

  const js = runSweep(["--root", root, "--no-gh", "--no-ssh", "--json"]);
  let parsed = null;
  try { parsed = JSON.parse(js.out); } catch (e) { check("--json parses", false, e.message); }
  if (parsed) {
    const w = parsed.repos.find((r) => r.name === "work");
    check("--json carries the same findings", !!w && w.local.stashes === 1 && w.worktrees.stray.length === 1 && w.branches.prUnknown.some((b) => b.branch === ORPHAN && b.ahead === 1), JSON.stringify(w?.local) + JSON.stringify(w?.worktrees));
    check("--json keeps the 'not captured' reasons", !!w && String(w.openPrs).startsWith("not captured") && String(w.prod.version).startsWith("not captured"), JSON.stringify({ openPrs: w?.openPrs, prod: w?.prod }));
  }

  const missing = runSweep(["--root", root, "--repos", "work,does-not-exist", "--no-gh", "--no-ssh"]);
  check("missing repo path exits non-zero", missing.code !== 0, `exit ${missing.code}`);
  check("...and says which path", missing.err.includes("does-not-exist") && /does not exist/.test(missing.err), missing.err.slice(0, 300));

  const badRoot = runSweep(["--root", join(root, "nope"), "--no-gh", "--no-ssh"]);
  check("missing --root exits non-zero with a reason", badRoot.code !== 0 && /not a directory/.test(badRoot.err), `exit ${badRoot.code}: ${badRoot.err.slice(0, 200)}`);
} catch (e) {
  check("fixture built and sweep ran", false, e.stack || String(e));
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
