#!/usr/bin/env node
// The monthly "new normal" sweep (#153): one read-only report across every
// project checkout, so the monthly review starts from facts, not memory.
// Changes nothing anywhere: it shells out to `git` (fetch --prune, then
// read-only queries) and `gh` (read-only API calls), and GETs a health
// endpoint where a repo's CLAUDE.md names one.
//
// Usage: node scripts/monthly-sweep.mjs [--root <dir>] [--repos a,b,c] [--json]
//                                        [--no-gh] [--no-fetch]
//                                        [--prod-url repo=http://host/health[,repo=url]]
//                                        [--ssh user@host | --no-ssh]
//
//   --root      the workspace root; every git checkout directly under it is a
//               project (default: the parent of this repo's checkout, i.e. the
//               folder quest-log itself lives in)
//   --repos     comma-separated directory names (or paths) to sweep instead of
//               every checkout under --root; a missing path is a hard error
//   --json      emit the same data as JSON instead of Markdown
//   --no-gh     skip every GitHub query (offline / fixture runs); the cells say
//               "not captured: --no-gh"
//   --no-fetch  skip `git fetch --prune` (the branch lists are then only as
//               fresh as the last fetch; the report says so)
//   --prod-url  where a project's prod health endpoint is, when its CLAUDE.md
//               does not name one (repeatable, or comma-separated)
//   --ssh       the NAS login for `docker inspect` of a container the repo's
//               CLAUDE.md names (default: hoop@10.0.1.78 with
//               ~/.ssh/id_ed25519_truenas when that key exists, batch mode,
//               5s connect timeout); --no-ssh skips the container probe
//
// Exit codes: 0 report produced (individual probes may still read "not
// captured: <reason>", that is a cell, not a failure); 2 bad invocation (a
// named repo path missing, gh not authenticated when gh is in use, --root not
// a directory). Never swallows a failing probe: every failure lands in its
// cell with the reason, and the summary table's "note" column names it.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- helpers

export const NOT_CAPTURED = "not captured";
const nc = (reason) => `${NOT_CAPTURED}: ${reason}`;
const isNc = (v) => typeof v === "string" && v.startsWith(NOT_CAPTURED);

function fail(msg) {
  console.error(`monthly-sweep: ${msg}`);
  process.exit(2);
}

// Run a command with explicit args (no shell, so Windows quoting is a
// non-issue). Returns { ok, out, err, code }.
function run(cmd, args, { cwd, timeout = 60_000, input } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout,
    input,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) {
    return { ok: false, out: "", err: r.error.code === "ENOENT" ? `${cmd} is not installed or not on PATH` : r.error.message, code: -1 };
  }
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), code: r.status };
}

const git = (cwd, args, opts) => run("git", ["-C", cwd, ...args], opts);
const gh = (args, opts) => run("gh", args, { timeout: 90_000, ...opts });

function reasonOf(r, what) {
  const msg = r.err || r.out || `exit ${r.code}`;
  return `${what} failed (${msg.split(/\r?\n/)[0].slice(0, 200)})`;
}

function ghJson(args, what) {
  const r = gh(args);
  if (!r.ok) return { error: reasonOf(r, what) };
  try {
    return { value: JSON.parse(r.out || "null") };
  } catch (e) {
    return { error: `${what} returned unparseable JSON (${e.message})` };
  }
}

function daysAgo(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null;
}

const day = (iso) => (iso ? iso.slice(0, 10) : "?");

// origin URL -> "owner/name" for GitHub remotes, else null
export function parseGitHubRemote(url) {
  if (!url) return null;
  const m = url.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

// --------------------------------------------------------------- argv

export function parseArgs(argv) {
  const opts = { root: null, repos: null, json: false, gh: true, fetch: true, prodUrls: {}, ssh: undefined, noSsh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--root") opts.root = next();
    else if (a === "--repos") opts.repos = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--json") opts.json = true;
    else if (a === "--no-gh") opts.gh = false;
    else if (a === "--no-fetch") opts.fetch = false;
    else if (a === "--no-ssh") opts.noSsh = true;
    else if (a === "--ssh") opts.ssh = next();
    else if (a === "--prod-url") {
      for (const pair of next().split(",")) {
        const eq = pair.indexOf("=");
        if (eq < 1) fail(`--prod-url expects repo=url, got "${pair}"`);
        opts.prodUrls[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
    } else if (a === "--help" || a === "-h") {
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split(/\r?\n/).filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
      process.exit(0);
    } else fail(`unknown argument "${a}" (see --help)`);
  }
  return opts;
}

function defaultRoot() {
  // scripts/monthly-sweep.mjs -> <checkout> -> its parent is the workspace.
  // A worktree under <checkout>/.claude/worktrees/<name> walks up to the same place.
  let dir = dirname(dirname(fileURLToPath(import.meta.url)));
  const wt = dir.match(/^(.*)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+$/);
  if (wt) dir = wt[1];
  return dirname(dir);
}

export function discoverRepos(root, named) {
  if (!existsSync(root) || !statSync(root).isDirectory()) fail(`--root ${root} is not a directory`);
  if (named) {
    return named.map((n) => {
      const p = resolve(root, n);
      if (!existsSync(p)) fail(`repo path ${p} does not exist (from --repos "${n}")`);
      if (!existsSync(join(p, ".git"))) fail(`repo path ${p} is not a git checkout (no .git)`);
      return p;
    });
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, ".git")))
    .map((d) => join(root, d.name))
    .sort((a, b) => basename(a).localeCompare(basename(b), undefined, { sensitivity: "base" }));
}

// ------------------------------------------------------- per-repo probes

function probeRemote(dir) {
  const r = git(dir, ["remote", "get-url", "origin"]);
  if (!r.ok) return { url: null, slug: null, reason: nc(reasonOf(r, "git remote get-url origin")) };
  const slug = parseGitHubRemote(r.out);
  return { url: r.out, slug, reason: slug ? null : nc(`origin is not a GitHub remote (${r.out})`) };
}

function probeDefaultBranch(dir, slug, useGh) {
  if (useGh && slug) {
    const j = ghJson(["repo", "view", slug, "--json", "defaultBranchRef"], "gh repo view");
    if (j.value?.defaultBranchRef?.name) return { name: j.value.defaultBranchRef.name, source: "gh" };
  }
  const r = git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (r.ok) return { name: r.out.replace(/^origin\//, ""), source: "origin/HEAD" };
  for (const cand of ["main", "master"]) {
    if (git(dir, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${cand}`]).ok) return { name: cand, source: "guess" };
  }
  return { name: null, source: null, reason: nc("no default branch: gh unavailable, no origin/HEAD, no origin/main or origin/master") };
}

function probeFetch(dir, doFetch) {
  if (!doFetch) return { done: false, reason: nc("--no-fetch; branch lists are as fresh as the last fetch") };
  const r = git(dir, ["fetch", "--prune", "--quiet", "origin"], { timeout: 120_000 });
  if (!r.ok) return { done: false, reason: nc(reasonOf(r, "git fetch --prune")) };
  return { done: true, reason: null };
}

function probePulls(slug, useGh) {
  if (!useGh) return { open: nc("--no-gh"), byBranch: nc("--no-gh") };
  if (!slug) return { open: nc("origin is not a GitHub remote"), byBranch: nc("origin is not a GitHub remote") };
  const openJ = ghJson(["pr", "list", "--repo", slug, "--state", "open", "--limit", "200", "--json", "number,title,createdAt,isDraft,mergeable,reviewDecision,headRefName,author"], "gh pr list --state open");
  const allJ = ghJson(["pr", "list", "--repo", slug, "--state", "all", "--limit", "1000", "--json", "number,state,headRefName,mergedAt,closedAt,title"], "gh pr list --state all");
  let open = openJ.error ? nc(openJ.error) : openJ.value.map((p) => ({
    number: p.number,
    title: p.title,
    ageDays: daysAgo(p.createdAt),
    draft: !!p.isDraft,
    mergeable: p.mergeable || "UNKNOWN",
    review: p.reviewDecision || "none",
    branch: p.headRefName,
    author: p.author?.login ?? "?",
  }));
  let byBranch;
  if (allJ.error) byBranch = nc(allJ.error);
  else {
    byBranch = new Map();
    // newest PR per branch wins (gh lists newest first)
    for (const p of allJ.value) if (!byBranch.has(p.headRefName)) byBranch.set(p.headRefName, p);
  }
  return { open, byBranch };
}

function probeBranches(dir, trunk, pulls) {
  const r = git(dir, ["for-each-ref", "refs/remotes/origin", "--format=%(refname)%09%(committerdate:iso-strict)%09%(objectname:short)%09%(symref)"]);
  if (!r.ok) return { error: nc(reasonOf(r, "git for-each-ref refs/remotes/origin")) };
  const out = { withOpenPr: [], mergedOrClosed: [], noPr: [], prUnknown: [], total: 0 };
  for (const line of r.out.split(/\r?\n/).filter(Boolean)) {
    const [fullRef, date, sha, symref] = line.split("\t");
    if (symref) continue; // origin/HEAD points at trunk; not a branch of its own
    const ref = fullRef.replace(/^refs\/remotes\//, "");
    const name = ref.replace(/^origin\//, "");
    if (name === "HEAD" || name === trunk) continue;
    out.total++;
    const entry = { branch: name, lastCommit: day(date), sha };
    if (trunk) {
      const ahead = git(dir, ["rev-list", "--count", `origin/${trunk}..${ref}`]);
      entry.ahead = ahead.ok ? Number(ahead.out) : nc(reasonOf(ahead, "git rev-list --count"));
    } else entry.ahead = nc("no trunk to compare against");
    if (isNc(pulls.byBranch)) {
      entry.pr = pulls.byBranch;
      out.prUnknown.push(entry);
      continue;
    }
    const pr = pulls.byBranch.get(name);
    if (!pr) out.noPr.push(entry);
    else if (pr.state === "OPEN") out.withOpenPr.push({ ...entry, pr: pr.number });
    else out.mergedOrClosed.push({ ...entry, pr: pr.number, prState: pr.state, when: day(pr.mergedAt || pr.closedAt) });
  }
  return out;
}

function probeLocal(dir, trunk) {
  const local = {};
  const head = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  local.branch = head.ok ? head.out : nc(reasonOf(head, "git rev-parse HEAD"));
  local.onTrunk = trunk ? local.branch === trunk : nc("no trunk known");
  const st = git(dir, ["status", "--porcelain"]);
  local.uncommitted = st.ok ? st.out.split(/\r?\n/).filter(Boolean).length : nc(reasonOf(st, "git status"));
  const stash = git(dir, ["stash", "list"]);
  local.stashes = stash.ok ? stash.out.split(/\r?\n/).filter(Boolean).length : nc(reasonOf(stash, "git stash list"));
  const up = git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!up.ok) local.unpushed = nc(`no upstream for ${local.branch}`);
  else {
    const c = git(dir, ["rev-list", "--count", "@{u}..HEAD"]);
    local.unpushed = c.ok ? Number(c.out) : nc(reasonOf(c, "git rev-list @{u}..HEAD"));
    local.upstream = up.out;
  }
  if (trunk && local.branch !== trunk) {
    const a = git(dir, ["rev-list", "--count", `origin/${trunk}..HEAD`]);
    const b = git(dir, ["rev-list", "--count", `HEAD..origin/${trunk}`]);
    local.vsTrunk = a.ok && b.ok ? { ahead: Number(a.out), behind: Number(b.out) } : nc("could not compare HEAD with origin/" + trunk);
  } else if (trunk) {
    const b = git(dir, ["rev-list", "--count", `HEAD..origin/${trunk}`]);
    local.behindTrunk = b.ok ? Number(b.out) : nc(reasonOf(b, "git rev-list HEAD..origin/trunk"));
  }
  return local;
}

function probeWorktrees(dir) {
  const r = git(dir, ["worktree", "list", "--porcelain"]);
  const known = [];
  if (r.ok) {
    let cur = null;
    for (const line of r.out.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) cur = { path: line.slice(9), branch: null };
      else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "" && cur) { known.push(cur); cur = null; }
    }
    if (cur) known.push(cur);
  }
  const knownPaths = new Set(known.map((w) => resolve(w.path).toLowerCase()));
  const strayDir = join(dir, ".claude", "worktrees");
  const stray = [];
  if (existsSync(strayDir)) {
    for (const d of readdirSync(strayDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = join(strayDir, d.name);
      if (!knownPaths.has(resolve(p).toLowerCase())) stray.push(p);
    }
  }
  const extra = known.filter((w) => resolve(w.path).toLowerCase() !== resolve(dir).toLowerCase());
  return { known: r.ok ? extra : nc(reasonOf(r, "git worktree list")), stray };
}

function probeTag(dir, trunk) {
  // Newest tag reachable from trunk = the rollback point; fall back to the
  // newest tag anywhere, and say which.
  if (trunk) {
    const r = git(dir, ["describe", "--tags", "--abbrev=0", `origin/${trunk}`]);
    if (r.ok) return { tag: r.out, where: `on ${trunk}` };
  }
  const any = git(dir, ["tag", "--sort=-creatordate"]);
  if (!any.ok) return { tag: nc(reasonOf(any, "git tag")), where: null };
  const first = any.out.split(/\r?\n/).filter(Boolean)[0];
  if (!first) return { tag: "none", where: null };
  return { tag: first, where: trunk ? `newest tag; none reachable from ${trunk}` : "newest tag" };
}

function probeIssues(slug, useGh, openPrCount) {
  if (!useGh) return nc("--no-gh");
  if (!slug) return nc("origin is not a GitHub remote");
  const j = ghJson(["api", `repos/${slug}`, "--jq", "{open_issues_count, archived, visibility}"], "gh api repos/<slug>");
  if (j.error) return nc(j.error);
  // GitHub's open_issues_count includes PRs
  const n = j.value.open_issues_count - (typeof openPrCount === "number" ? openPrCount : 0);
  return { count: n, archived: !!j.value.archived, visibility: j.value.visibility };
}

function probeTests(dir) {
  const declared = [];
  if (existsSync(join(dir, "package.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.scripts?.test) declared.push(`npm test (${pkg.scripts.test.slice(0, 60)})`);
    } catch (e) {
      declared.push(`package.json unreadable (${e.message})`);
    }
  }
  if (existsSync(join(dir, "scripts"))) {
    const n = readdirSync(join(dir, "scripts")).filter((f) => /^test[-_].*\.(mjs|js|py|sh)$/.test(f)).length;
    if (n) declared.push(`${n} scripts/test-* file${n === 1 ? "" : "s"}`);
  }
  for (const d of ["tests", "test", "__tests__", "spec"]) if (existsSync(join(dir, d)) && statSync(join(dir, d)).isDirectory()) declared.push(`${d}/`);
  for (const f of ["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"]) {
    if (existsSync(join(dir, f)) && /pytest/.test(readFileSync(join(dir, f), "utf8"))) declared.push(f + " (pytest)");
  }
  const ci = existsSync(join(dir, ".github", "workflows")) ? readdirSync(join(dir, ".github", "workflows")).filter((f) => /\.ya?ml$/.test(f)) : [];
  return { declared, ciWorkflows: ci };
}

function probeCi(dir, slug, trunk, useGh, workflows) {
  if (!useGh) return nc("--no-gh");
  if (!slug) return nc("origin is not a GitHub remote");
  if (!trunk) return nc("no trunk known");
  const sha = git(dir, ["rev-parse", `origin/${trunk}`]);
  if (!sha.ok) return nc(reasonOf(sha, "git rev-parse origin/trunk"));
  const j = ghJson(["api", `repos/${slug}/commits/${sha.out}/check-runs`, "--jq", "{total_count, runs: [.check_runs[] | {name, status, conclusion}]}"], "gh api check-runs");
  if (j.error) return nc(j.error);
  const runs = j.value.runs ?? [];
  if (!runs.length) return workflows.length ? `no check runs on ${trunk}@${sha.out.slice(0, 7)} although ${workflows.length} workflow file(s) exist` : `none (no CI declared, no check runs on ${trunk}@${sha.out.slice(0, 7)})`;
  const tally = {};
  for (const r of runs) {
    const k = r.status === "completed" ? (r.conclusion || "unknown") : r.status;
    tally[k] = (tally[k] || 0) + 1;
  }
  return { sha: sha.out.slice(0, 7), runs: runs.map((r) => `${r.name}: ${r.status === "completed" ? r.conclusion : r.status}`), tally };
}

const HEALTH_PATHS = ["/health", "/healthz", "/api/version", "/version"];

function readClaudeMd(dir) {
  const p = join(dir, "CLAUDE.md");
  if (!existsSync(p)) return null;
  try { return readFileSync(p, "utf8"); } catch (e) { return `__unreadable__ ${e.message}`; }
}

// What the repo's own CLAUDE.md says about where prod lives: absolute health
// URLs; or a health path plus a non-dev .local host to compose one; plus
// backticked container names it talks about.
export function prodHintsFromClaudeMd(text, repoName = "") {
  const hints = { urls: [], containers: [], reasons: [] };
  if (text == null) { hints.reasons.push("no CLAUDE.md in the repo"); return hints; }
  if (text.startsWith("__unreadable__")) { hints.reasons.push(`CLAUDE.md ${text.slice(15)}`); return hints; }
  const abs = [...text.matchAll(/https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(\/[A-Za-z0-9._\/-]*)?/g)]
    .map((m) => m[0].replace(/[.,;:)]+$/, ""))
    .filter((u) => HEALTH_PATHS.some((h) => new URL(u).pathname === h) && !/localhost|127\.0\.0\.1/.test(u));
  hints.urls.push(...new Set(abs));
  if (!hints.urls.length) {
    const paths = HEALTH_PATHS.filter((h) => new RegExp("`" + h.replace(/\//g, "\\/") + "`").test(text) || new RegExp("(?<![\\w/])" + h.replace(/\//g, "\\/") + "(?![\\w/])").test(text));
    const hosts = [...new Set([...text.matchAll(/\b([a-z0-9-]+\.local)\b/g)].map((m) => m[1]))].filter((h) => !/-(dev|test)\.local$/.test(h));
    if (paths.length && hosts.length) hints.urls.push(`http://${hosts[0]}${paths[0]}`);
    else if (paths.length) hints.reasons.push(`CLAUDE.md names ${paths.join(", ")} but no .local host to put in front of it`);
    else hints.reasons.push("CLAUDE.md names no health endpoint (/health, /healthz, /api/version, /version)");
  }
  // Container names: backticked words next to the word "container" or after a
  // docker verb, kept only when they look like this project's (share the repo
  // name, e.g. constructicon-web for Constructicon), prod ones first. Prose
  // like "a video's container `creation_time`" must not become a probe.
  const seen = new Set();
  const stem = repoName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-(work|main|checkout|\d+)$/, "");
  for (const m of text.matchAll(/(?:container[s]?\s+(?:named\s+)?`([a-z0-9][a-z0-9_.-]{2,})`|`([a-z0-9][a-z0-9_.-]{2,})`\s+container|docker (?:inspect|restart|logs|exec)\s+([a-z0-9][a-z0-9_.-]{2,}))/g)) {
    const name = m[1] || m[2] || m[3];
    if (!name || seen.has(name)) continue;
    const looksOurs = stem && (name.toLowerCase().includes(stem) || stem.includes(name.toLowerCase()));
    if (looksOurs) { seen.add(name); hints.containers.push(name); }
  }
  const rank = (c) => (/-(test|dev|staging)(-|$)/.test(c) ? 2 : /-(mcp|ollama|restarter|worker)(-|$)/.test(c) ? 1 : 0);
  hints.containers.sort((a, b) => rank(a) - rank(b));
  if (!hints.containers.length) hints.reasons.push(stem ? `CLAUDE.md names no container that looks like ${stem}'s` : "CLAUDE.md names no container");
  return hints;
}

async function fetchVersion(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "follow" });
    const body = (await res.text()).slice(0, 2000);
    if (!res.ok) return { error: `${url} answered HTTP ${res.status} (${body.slice(0, 120).replace(/\s+/g, " ")})` };
    let json;
    try { json = JSON.parse(body); } catch { return { error: `${url} answered ${res.status} but not JSON (${body.slice(0, 80).replace(/\s+/g, " ")})` }; }
    const v = json.version ?? json.app_version ?? json.release ?? json.tag;
    if (v == null) return { error: `${url} answered ${res.status} with no version field (keys: ${Object.keys(json).join(", ") || "none"})` };
    return { version: String(v), extra: json.hooksVersion ? `hooks ${json.hooksVersion}` : null, url };
  } catch (e) {
    return { error: `${url} unreachable (${e.cause?.code || e.name || e.message})` };
  }
}

function sshDefault(opts) {
  if (opts.noSsh) return null;
  if (opts.ssh) return { target: opts.ssh, key: null };
  const key = join(homedir(), ".ssh", "id_ed25519_truenas");
  return { target: "hoop@10.0.1.78", key: existsSync(key) ? key : null };
}

function inspectContainer(ssh, name) {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=accept-new"];
  if (ssh.key) args.push("-i", ssh.key);
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name)) return { error: `container name "${name}" has characters this probe will not pass to a remote shell` };
  // ssh joins its arguments into one remote command line, so the Go template
  // travels as a single, single-quoted argument or the remote shell splits it.
  const remote = `sudo docker inspect --format '{{.State.Status}}|{{.Config.Image}}|{{index .Config.Labels "org.opencontainers.image.version"}}' ${name}`;
  args.push(ssh.target, remote);
  const r = run("ssh", args, { timeout: 20_000 });
  if (!r.ok) return { error: `docker inspect ${name} over ssh ${ssh.target} failed (${(r.err || r.out || "exit " + r.code).split(/\r?\n/)[0].slice(0, 160)})` };
  const [status, image, label] = r.out.split("|");
  const ver = (label || "").trim() || (image?.includes(":") ? image.split(":").pop() : "");
  return { version: ver || `${status}, image ${image}, no version label`, extra: `container ${name} ${status}, image ${image}`, container: name };
}

async function probeProd(dir, name, opts) {
  const hints = prodHintsFromClaudeMd(readClaudeMd(dir), name);
  const override = opts.prodUrls[name];
  const urls = override ? [override, ...hints.urls] : hints.urls;
  const tried = [];
  for (const u of urls) {
    const r = await fetchVersion(u);
    if (r.version) return { version: r.version, source: `${u}${r.extra ? ` (${r.extra})` : ""}`, tried };
    tried.push(r.error);
  }
  const ssh = sshDefault(opts);
  for (const c of hints.containers) {
    if (!ssh) { tried.push(`container ${c} named in CLAUDE.md but --no-ssh given`); continue; }
    const r = inspectContainer(ssh, c);
    if (r.version) return { version: r.version, source: r.extra, tried };
    tried.push(r.error);
  }
  const reasons = [...tried, ...hints.reasons];
  return { version: nc(reasons.join("; ") || "nothing to try"), source: null, tried };
}

// ----------------------------------------------------------- the sweep

export async function sweepRepo(dir, opts) {
  const name = basename(dir);
  const rep = { name, path: dir };
  const remote = probeRemote(dir);
  rep.remote = remote.url;
  rep.slug = remote.slug;
  rep.remoteNote = remote.reason;
  rep.fetch = probeFetch(dir, opts.fetch);
  const db = probeDefaultBranch(dir, remote.slug, opts.gh);
  rep.trunk = db.name;
  rep.trunkNote = db.reason ?? null;
  const pulls = probePulls(remote.slug, opts.gh);
  rep.openPrs = pulls.open;
  rep.branches = probeBranches(dir, db.name, pulls);
  rep.local = probeLocal(dir, db.name);
  rep.worktrees = probeWorktrees(dir);
  rep.tag = probeTag(dir, db.name);
  rep.issues = probeIssues(remote.slug, opts.gh, Array.isArray(pulls.open) ? pulls.open.length : null);
  rep.tests = probeTests(dir);
  rep.ci = probeCi(dir, remote.slug, db.name, opts.gh, rep.tests.ciWorkflows);
  rep.prod = await probeProd(dir, name, opts);
  rep.note = buildNote(rep);
  return rep;
}

function buildNote(rep) {
  const n = [];
  const L = rep.local;
  if (rep.remoteNote) n.push(rep.remoteNote);
  if (rep.trunkNote) n.push(rep.trunkNote);
  if (!rep.fetch.done) n.push(rep.fetch.reason);
  if (L.onTrunk === false) n.push(`checkout on ${L.branch}, not ${rep.trunk}`);
  if (typeof L.uncommitted === "number" && L.uncommitted) n.push(`${L.uncommitted} uncommitted`);
  if (typeof L.stashes === "number" && L.stashes) n.push(`${L.stashes} stash${L.stashes === 1 ? "" : "es"}`);
  if (typeof L.unpushed === "number" && L.unpushed) n.push(`${L.unpushed} unpushed`);
  if (typeof L.behindTrunk === "number" && L.behindTrunk) n.push(`${L.behindTrunk} behind origin/${rep.trunk}`);
  const B = rep.branches;
  if (B.error) n.push(B.error);
  else {
    if (B.mergedOrClosed.length) n.push(`${B.mergedOrClosed.length} merged/closed-PR branch${B.mergedOrClosed.length === 1 ? "" : "es"} to delete`);
    if (B.noPr.length) n.push(`${B.noPr.length} PR-less branch${B.noPr.length === 1 ? "" : "es"}`);
    if (B.prUnknown.length) n.push(`${B.prUnknown.length} remote branch${B.prUnknown.length === 1 ? "" : "es"}, PR state ${B.prUnknown[0].pr}`);
  }
  if (rep.worktrees.stray.length) n.push(`${rep.worktrees.stray.length} stray dir${rep.worktrees.stray.length === 1 ? "" : "s"} under .claude/worktrees`);
  if (Array.isArray(rep.worktrees.known) && rep.worktrees.known.length) n.push(`${rep.worktrees.known.length} worktree${rep.worktrees.known.length === 1 ? "" : "s"}`);
  if (isNc(rep.ci)) n.push(`CI ${rep.ci}`);
  else if (typeof rep.ci === "object" && rep.ci.tally && Object.keys(rep.ci.tally).some((k) => k !== "success")) n.push(`CI on trunk: ${Object.entries(rep.ci.tally).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  if (!rep.tests.declared.length) n.push("no test suite declared");
  if (typeof rep.issues === "object" && rep.issues.archived) n.push("repo archived on GitHub");
  return n.length ? n.join("; ") : "clean";
}

export async function sweep(opts) {
  const root = resolve(opts.root ?? defaultRoot());
  if (opts.gh) {
    const auth = gh(["auth", "status"], { timeout: 30_000 });
    if (!auth.ok) fail(`gh auth status failed; GitHub queries need a logged-in gh (run \`gh auth login\`, or pass --no-gh for a git-only sweep). gh said: ${(auth.err || auth.out).split(/\r?\n/).slice(0, 3).join(" | ")}`);
  }
  const dirs = discoverRepos(root, opts.repos);
  if (!dirs.length) fail(`no git checkouts found directly under ${root}`);
  const repos = [];
  for (const d of dirs) {
    if (!opts.json) process.stderr.write(`sweeping ${basename(d)}...\n`);
    repos.push(await sweepRepo(d, opts));
  }
  return { generatedAt: new Date().toISOString(), root, options: { gh: opts.gh, fetch: opts.fetch }, repos };
}

// -------------------------------------------------------------- Markdown

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const n = (v) => (typeof v === "number" ? String(v) : cell(v));

function prList(prs) {
  if (isNc(prs)) return `- ${prs}`;
  if (!prs.length) return "- none";
  return prs.map((p) => `- #${p.number} ${p.title} (${p.branch}; ${p.ageDays}d old; ${p.draft ? "draft; " : ""}mergeable ${p.mergeable}; review ${p.review}; by ${p.author})`).join("\n");
}

export function renderMarkdown(result) {
  const out = [];
  out.push(`# Monthly sweep ${result.generatedAt.slice(0, 10)}`, "");
  out.push(`Root: \`${result.root}\`. Generated ${result.generatedAt}. Read-only: nothing was changed. ${result.options.gh ? "GitHub queried through gh." : "GitHub NOT queried (--no-gh)."} ${result.options.fetch ? "Each repo was `git fetch --prune`d first." : "No fetch (--no-fetch)."}`, "");
  for (const r of result.repos) {
    out.push(`## ${r.name}`, "");
    out.push(`- Path: \`${r.path}\``);
    out.push(`- Remote: ${r.remote ? `\`${r.remote}\`` : "none"}${r.slug ? ` (GitHub ${r.slug})` : ""}${r.remoteNote ? ` — ${r.remoteNote}` : ""}`);
    out.push(`- Trunk: ${r.trunk ? `\`${r.trunk}\`` : r.trunkNote}`);
    if (!r.fetch.done) out.push(`- Fetch: ${r.fetch.reason}`);
    out.push(`- Prod version: ${r.prod.version}${r.prod.source ? ` (from ${r.prod.source})` : ""}`);
    if (r.prod.source && r.prod.tried.length) out.push(`  - also tried: ${r.prod.tried.join("; ")}`);
    out.push(`- Latest tag: ${r.tag.tag}${r.tag.where ? ` (${r.tag.where})` : ""}`);
    out.push(`- Open issues: ${typeof r.issues === "object" ? `${r.issues.count} (${r.issues.visibility}${r.issues.archived ? ", ARCHIVED" : ""})` : r.issues}`);
    out.push(`- Tests declared: ${r.tests.declared.length ? r.tests.declared.join("; ") : "none found"}; CI workflows: ${r.tests.ciWorkflows.length ? r.tests.ciWorkflows.join(", ") : "none"}`);
    out.push(`- CI on trunk head: ${typeof r.ci === "object" ? `${r.ci.sha}: ${r.ci.runs.join("; ")}` : r.ci}`);
    out.push("", "### Open PRs", "", prList(r.openPrs), "");
    const B = r.branches;
    if (B.error) out.push("### Remote branches", "", `- ${B.error}`, "");
    else {
      out.push(`### Remote branches whose PR is merged or closed (${B.mergedOrClosed.length})`, "");
      out.push(B.mergedOrClosed.length ? B.mergedOrClosed.map((b) => `- \`${b.branch}\` — PR #${b.pr} ${b.prState.toLowerCase()} ${b.when}; ${n(b.ahead)} ahead of ${r.trunk}; last commit ${b.lastCommit}`).join("\n") : "- none", "");
      out.push(`### Remote branches with no PR (${B.noPr.length})`, "");
      out.push(B.noPr.length ? B.noPr.map((b) => `- \`${b.branch}\` — ${n(b.ahead)} ahead of ${r.trunk}; last commit ${b.lastCommit}`).join("\n") : "- none", "");
      if (B.prUnknown.length) {
        out.push(`### Remote branches, PR state not captured (${B.prUnknown.length})`, "", `- ${B.prUnknown[0].pr}`);
        out.push(B.prUnknown.map((b) => `- \`${b.branch}\` — ${n(b.ahead)} ahead of ${r.trunk ?? "?"}; last commit ${b.lastCommit}`).join("\n"), "");
      }
      if (B.withOpenPr.length) out.push(`Branches with an open PR: ${B.withOpenPr.map((b) => `\`${b.branch}\` (#${b.pr})`).join(", ")}.`, "");
    }
    const L = r.local;
    out.push("### Local checkout", "");
    out.push(`- Branch: \`${L.branch}\`${L.onTrunk === true ? " (trunk)" : L.onTrunk === false ? ` (NOT trunk \`${r.trunk}\`; ${typeof L.vsTrunk === "object" ? `${L.vsTrunk.ahead} ahead, ${L.vsTrunk.behind} behind` : L.vsTrunk})` : ` (${L.onTrunk})`}`);
    if (L.behindTrunk !== undefined) out.push(`- Behind origin/${r.trunk}: ${n(L.behindTrunk)}`);
    out.push(`- Uncommitted files: ${n(L.uncommitted)}`);
    out.push(`- Stashes: ${n(L.stashes)}`);
    out.push(`- Unpushed commits: ${n(L.unpushed)}${L.upstream ? ` (upstream ${L.upstream})` : ""}`);
    out.push("", "### Worktrees", "");
    if (isNc(r.worktrees.known)) out.push(`- ${r.worktrees.known}`);
    else if (!r.worktrees.known.length) out.push("- none registered beyond the main checkout");
    else for (const w of r.worktrees.known) out.push(`- \`${w.path}\` on \`${w.branch ?? "(detached)"}\``);
    if (r.worktrees.stray.length) for (const s of r.worktrees.stray) out.push(`- STRAY (directory under .claude/worktrees that git does not know): \`${s}\``);
    else out.push("- no stray directories under .claude/worktrees");
    out.push("", `**Note:** ${r.note}`, "");
  }
  out.push("## Snapshot", "");
  out.push("| project | prod version | rollback tag | open PRs | open issues | stranger-installable | note |");
  out.push("|---|---|---|---|---|---|---|");
  for (const r of result.repos) {
    out.push(`| ${cell(r.name)} | ${cell(r.prod.version)} | ${cell(r.tag.tag)} | ${isNc(r.openPrs) ? cell(r.openPrs) : r.openPrs.length} | ${typeof r.issues === "object" ? r.issues.count : cell(r.issues)} | not assessed | ${cell(r.note)} |`);
  }
  out.push("");
  return out.join("\n");
}

// ------------------------------------------------------------------ main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = await sweep(opts);
  process.stdout.write(opts.json ? JSON.stringify(result, null, 2) + "\n" : renderMarkdown(result));
}

if (process.argv[1] && import.meta.url === new URL(`file:///${resolve(process.argv[1]).replace(/\\/g, "/")}`).href) {
  await main();
}
