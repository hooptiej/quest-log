---
name: monthly-review
description: >
  Runs hooptiej's monthly "new normal" review across every self-hosted project: sweeps each
  repo for leftovers (orphaned branches, stray worktrees, dangling PRs, checkouts off trunk,
  stashes), compares the snapshot with last month's, walks the owner through the cleanups with
  a multi-select pick before anything is closed or deleted, assesses whether a stranger could
  install each project, and files the month's mission in quest-log so next month has a
  comparison point. Trigger when the owner says "monthly review", "new normal review", "sweep
  the sawdust", "pick up the mess" or asks how the projects compare with last month. Kickoff
  is manual for now; do not run it on your own initiative.
compatibility: >
  Requires the quest-log MCP server (tools prefixed mcp__quest-log__), a logged-in `gh`, git,
  and Node 18+ for scripts/monthly-sweep.mjs in the quest-log checkout. Reaches the NAS over
  ssh for container versions (optional; pass --no-ssh when off the home LAN).
---

# Monthly review

Once a month hooptiej picks up the mess across a dozen projects and confirms each one is at
parity or better than last month. The record is **one mission per month under the quest
"Monthly 'new normal' review"** (quest id `monthly-new-normal-review-pick-up-the-me-mvwt5ger`)
in quest-log; the first one, `2026-10 review (first run, baseline)`, is the comparison point for
November. The design is hooptiej/quest-log#153. Two halves:

- **The sweep** (`scripts/monthly-sweep.mjs` in the quest-log repo) gathers the facts. Read-only,
  shells out to `git` and `gh`, prints Markdown (or `--json`). It never decides anything.
- **This skill** is the judgment half: compare, ask, clean up, assess, file.

Decisions already made, not to re-litigate: the record lives in quest-log, not a markdown file;
kickoff is manual for the first two cycles (a scheduled wrapper is a separate, later issue);
the tooling ships through the quest-log plugin so both machines get the same version.

## Steps

### 1. Run the sweep

From a quest-log checkout (the plugin's own copy works too; it is the repo):

```bash
node scripts/monthly-sweep.mjs > "$TMPDIR/sweep-$(date +%Y-%m).md"
```

- Default root is the workspace folder the quest-log checkout lives in (every git checkout
  directly under it is a project). `--root <dir>` and `--repos a,b,c` override that.
- It `git fetch --prune`s each repo first, so the branch lists are real (the October run
  counted 119 phantom branches from stale refs before pruning).
- It exits non-zero only for a bad invocation (gh not logged in, a named repo path missing).
  Every failed probe stays in its cell as `not captured: <reason>`. **Read those reasons and
  carry them into the "gaps in this run" list; never paper over them.**
- Prod version comes from a health endpoint the repo's own `CLAUDE.md` names (an absolute
  `/health`-style URL, or a health path plus a `.local` host), then from `docker inspect` of a
  container the CLAUDE.md names (over ssh to the NAS). When a project's CLAUDE.md names
  neither, pass `--prod-url <repo>=<url>` for this run **and** note it as a gap: the fix is a
  line in that project's CLAUDE.md, not a flag forever.
- Keep the whole report; the per-repo sections are what the cleanup question is built from.
  Do not paste the full report into chat; summarise and keep the file.

### 2. Compare with last month

`mcp__quest-log__list_quests(level: "mission", tree: false)` and pick the newest mission under
the review quest (parentId `monthly-new-normal-review-pick-up-the-me-mvwt5ger`); read its notes
in full. Its snapshot table has the same columns as the sweep's:

`project | prod version | rollback tag | open PRs | open issues | stranger-installable | note`

Line the two tables up and call out, per project:

- prod version moved (forward is good; the same is fine; a rollback is worth a sentence);
- rollback tag appeared, disappeared or is still `none` (a project that runs in prod with no
  tag has no rollback point; that is a finding every month until it is fixed);
- open PRs and open issues up or down (direction matters more than the number);
- a note that got longer (new mess) or shorter (mess picked up);
- a project present last month and missing now, or new this month.

Also check last month's "gaps in this run" list: every item on it should now be either
captured or still a gap with a reason. A gap that silently vanished without being captured is
itself a finding.

### 3. Ask before touching anything

Build the cleanup candidates from the sweep, one line each, grouped by project:

- remote branches whose PR is merged or closed → candidate **delete** (`git push origin --delete`);
- remote branches with no PR → **delete** if 0 ahead of trunk, otherwise ask (**keep** / open a
  PR / delete), showing commits ahead and last-commit date;
- open PRs → **merge**, **close**, or **keep**, with age, mergeable state and review state
  shown; **never merge from this skill without the owner's explicit yes on that PR** (the
  standing rule: the owner confirms merges himself);
- stray directories under `.claude/worktrees/` → **delete** (`git worktree prune` first, then
  remove the directory);
- registered worktrees whose branch is merged → **remove** (`git worktree remove`);
- checkouts off trunk, uncommitted files, stashes, unpushed commits → **keep** by default and
  name them; a stash or uncommitted edit is someone's work, not sawdust. Only act on these when
  the owner picks it explicitly.

Present them with one multi-select `AskUserQuestion` per project (or per batch of related
items when a project has many), option labels **close / merge / delete / keep** per item, with
`keep` the default read of a no-answer. Mark your recommendation but do not act on it.

**Never delete, close or merge anything without that pick.** An unanswered question means stop
and re-ask, or hold that item and list it under "deferred" on the mission. This is the owner's
"ask more, act less" rule applied to the one place it matters most.

### 4. Run the agreed cleanups

Do exactly the picks, nothing more, and verify each one (`git ls-remote --heads origin <branch>`
empty after a delete; `gh pr view <n> --json state` after a close or merge; `git worktree
list` after a prune). Report each as done, failed (with the error) or skipped, never as a bare
"cleaned up". A failed cleanup goes on the mission as a gap with its error.

### 5. Assess stranger-installable per project

The sweep writes `not assessed` in that column on purpose; this is the judgment call. For each
project answer **yes / partial / no** against the owner's standing bar (the "stable, deployable
Docker images for every project" rule): app code baked into the image; images tagged with the
release version; pinned base images and dependencies, no `:latest`; every sidecar in the
project's own compose, optional where possible; per-install config through env and secrets
files with no home-specific paths baked in; a README a stranger can follow from clone to
running. Name the blocking issue numbers for anything short of **yes** (file them if they do
not exist: "no issue, no fix"). Retired projects (homedash, scrypted-mcp) and upstream
reference checkouts (imagerepo) get `n/a (retired)` or `n/a (upstream)`.

**Flag any project whose answer went backwards from last month** (yes → partial, partial →
no) at the top of the mission notes and in chat. Going backwards is the one thing this review
exists to catch.

### 6. File the month's mission

`mcp__quest-log__add_idea` with `level: "mission"`, `parentIdOrTitle:
"monthly-new-normal-review-pick-up-the-me-mvwt5ger"`, `status: "done"` once the cleanups are
in, title `YYYY-MM review`, and notes holding, in this order:

1. **Regressions** (stranger-installable went backwards; a prod rollback; a project that
   disappeared), or "none".
2. **Snapshot**: the table with the fixed columns, the `stranger-installable` column filled in
   from step 5, the `note` column tightened to what matters.
3. **Changes since last month**: the comparison from step 2, one line per project that moved.
4. **Cleanups done**: each pick and its verified result; **deferred**: anything the owner
   chose to keep or did not answer.
5. **Gaps in this run**: every `not captured` cell with its reason, every project whose
   CLAUDE.md names no health endpoint, every probe that failed, and what would close each gap
   (an issue number where one exists).
6. **Next month**: anything to do before the next run (a CLAUDE.md line to add, a tag to
   cut, an issue to land).

Notes are plain text; no `</script` or `<!--` sequences (quest-log refuses them). Keep the
whole thing under a screen or two; the sweep file holds the detail.

### 7. Close out

- Tell the owner in a few lines: regressions, cleanups done, gaps, and the mission id.
- `mcp__quest-log__add_log_entry` with a one-liner ("2026-11 monthly review filed: N cleanups,
  M gaps, no regressions").
- Keep the sweep's Markdown file where the owner can open it; do not commit it anywhere.
- If this is the second manual cycle, remind the owner that the scheduled-routine wrapper is
  the next step and ask whether to file that issue now.

## What this skill never does

- Run `git push --delete`, `gh pr close`, `gh pr merge`, `git worktree remove`, `git stash
  drop` or delete a directory without the owner's pick for that exact item.
- Merge a PR on its own recommendation.
- Commit the sweep report into any repo.
- Treat `not captured` as zero, none or fine.
- Rewrite last month's mission; each month gets its own.
