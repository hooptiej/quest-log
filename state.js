import { readFile, writeFile, rename } from "node:fs/promises";

const DATA_PATH = process.env.DATA_PATH ?? new URL("./data/state.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

export async function readState() {
  const raw = await readFile(DATA_PATH, "utf8");
  return JSON.parse(raw);
}

async function writeStateRaw(state) {
  const tmpPath = `${DATA_PATH}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(state, null, 2));
  await rename(tmpPath, DATA_PATH);
}

// Serializes every read-modify-write against state.json so concurrent
// writers (browser tabs, MCP tool calls) can't silently clobber each
// other -- each mutation sees the result of every mutation queued before it.
let writeLock = Promise.resolve();

export function mutateState(mutator) {
  const run = writeLock.then(async () => {
    const state = await readState();
    const result = await mutator(state);
    // Runs after every mutation (MCP tool call, browser full-state save) so
    // the two write paths can never disagree about readyToClose or a stale
    // "done" left over from a child that got reopened elsewhere.
    recomputeRollups(state);
    state._version = (state._version ?? 0) + 1;
    await writeStateRaw(state);
    return { state, result, version: state._version };
  });
  // Keep the chain alive even if this mutation throws, so later ones still run.
  writeLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function slugify(title) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "idea"}-${Date.now().toString(36)}`;
}

const VALID_STATUSES = new Set(["idea", "progress", "blocked", "done"]);
const VALID_LEVELS = new Set(["quest", "mission", "task"]);
// A level may only be parented by the tier directly above it; a quest is
// always top-level. Keeping this as the single source of truth means
// validateState and the MCP tools' parent-resolution can't disagree.
const PARENT_LEVEL = { quest: null, mission: "quest", task: "mission" };

export function isValidQuest(q) {
  return (
    q &&
    typeof q === "object" &&
    typeof q.id === "string" &&
    q.id.length > 0 &&
    typeof q.title === "string" &&
    q.title.length > 0 &&
    VALID_STATUSES.has(q.status) &&
    VALID_LEVELS.has(q.level) &&
    (q.parentId === null || q.parentId === undefined || typeof q.parentId === "string")
  );
}

export function validateState(state) {
  if (!state || !Array.isArray(state.quests) || !Array.isArray(state.log)) {
    return "expected { quests: [], log: [] }";
  }
  for (const q of state.quests) {
    if (!isValidQuest(q)) {
      return `invalid quest: ${JSON.stringify(q).slice(0, 200)}`;
    }
  }
  const ids = new Set();
  for (const q of state.quests) {
    if (ids.has(q.id)) return `duplicate quest id: ${q.id}`;
    ids.add(q.id);
  }
  const byId = new Map(state.quests.map((q) => [q.id, q]));
  for (const q of state.quests) {
    const expectedParentLevel = PARENT_LEVEL[q.level];
    if (expectedParentLevel === null) {
      if (q.parentId) return `${describeQuest(q)} is a quest and can't have a parent`;
      continue;
    }
    if (!q.parentId) continue; // an ungrouped mission is allowed to have no parent yet
    const parent = byId.get(q.parentId);
    if (!parent) return `${describeQuest(q)} has parentId "${q.parentId}", which doesn't exist`;
    if (parent.level !== expectedParentLevel) {
      return `${describeQuest(q)} (level ${q.level}) must be parented by a ${expectedParentLevel}, but "${q.parentId}" is a ${parent.level}`;
    }
  }
  // A parent may only be "done" via confirmCompletion (which stamps this
  // marker) -- reject any payload that smuggles a parent straight to done,
  // e.g. a raw POST /api/state replay, without going through the gate.
  for (const q of state.quests) {
    if (q.status !== "done") continue;
    const hasChildren = state.quests.some((c) => c.parentId === q.id);
    if (hasChildren && !q._confirmedDone) {
      return `${describeQuest(q)} has children and can't be set to "done" directly -- use confirm_completion`;
    }
  }
  return null;
}

// Every mission/quest with children gets its readyToClose flag recomputed
// bottom-up (tasks are always leaves, so two passes -- missions then quests
// -- is enough for this fixed three-tier depth). A parent's status is never
// written to "done" here; that only ever happens in confirmCompletion. If a
// child leaves "done" after its parent was confirmed done, the parent is
// reverted automatically, since the confirmation no longer holds.
export function recomputeRollups(state) {
  for (const level of ["mission", "quest"]) {
    for (const parent of state.quests) {
      if (parent.level !== level) continue;
      const children = state.quests.filter((c) => c.parentId === parent.id);
      if (children.length === 0) {
        delete parent.readyToClose;
        continue;
      }
      const allDone = children.every((c) => c.status === "done");
      if (allDone) {
        if (parent.status !== "done") parent.readyToClose = true;
        else delete parent.readyToClose;
      } else {
        delete parent.readyToClose;
        if (parent.status === "done") {
          parent.status = parent._prevStatus || "progress";
          delete parent._confirmedDone;
        }
      }
    }
  }
}

// The only path that may set a parent's status to "done". Eligible when the
// item has no children (a plain leaf -- behaves like today's manual close)
// or when recomputeRollups has already flagged it readyToClose (every child
// done). Returns { error } if not eligible, or { quest } on success.
export function confirmCompletion(state, idOrTitle) {
  const resolved = resolveOne(state, idOrTitle);
  if (resolved.error) return resolved;
  const quest = resolved.quest;
  const hasChildren = state.quests.some((c) => c.parentId === quest.id);
  if (hasChildren && !quest.readyToClose) {
    return { error: `${describeQuest(quest)} still has unfinished children -- not ready to close yet` };
  }
  if (quest.status !== "done") {
    quest._prevStatus = quest.status;
    quest.date = quest.date ?? todayISO();
  }
  quest.status = "done";
  quest._confirmedDone = true;
  delete quest.readyToClose;
  recomputeRollups(state);
  return { quest };
}

export function resolveOne(state, idOrTitle) {
  const matches = findQuestCandidates(state, idOrTitle);
  if (matches.length === 0) return { error: `No quest found matching "${idOrTitle}"` };
  if (matches.length > 1) return { error: `Ambiguous match for "${idOrTitle}": ${matches.map(describeQuest).join(", ")}. Use the exact id instead.` };
  return { quest: matches[0] };
}

// Resolves a parent reference for add_idea, checking it's the correct tier
// (a mission's parent must be a quest, a task's must be a mission) so a
// child can't silently attach to the wrong level.
export function resolveParent(state, parentIdOrTitle, childLevel) {
  const expectedLevel = PARENT_LEVEL[childLevel];
  if (!parentIdOrTitle) return { parentId: null };
  if (!expectedLevel) return { error: `a ${childLevel} can't have a parent` };
  const resolved = resolveOne(state, parentIdOrTitle);
  if (resolved.error) return resolved;
  if (resolved.quest.level !== expectedLevel) {
    return { error: `${describeQuest(resolved.quest)} is a ${resolved.quest.level}, but a ${childLevel}'s parent must be a ${expectedLevel}` };
  }
  return { parentId: resolved.quest.id };
}

// Returns every quest matching idOrTitle, most-specific match first:
// an exact id match always wins outright (returned alone); otherwise
// exact (case-insensitive) title matches, then substring matches, are
// returned as a group so callers can detect and reject ambiguity
// instead of silently picking whichever quest happens to be first.
export function findQuestCandidates(state, idOrTitle) {
  const byId = state.quests.find((q) => q.id === idOrTitle);
  if (byId) return [byId];

  const lower = idOrTitle.toLowerCase();
  const byExactTitle = state.quests.filter((q) => q.title.toLowerCase() === lower);
  if (byExactTitle.length > 0) return byExactTitle;

  return state.quests.filter((q) => q.title.toLowerCase().includes(lower));
}

export function describeQuest(q) {
  return `${q.id} ("${q.title}")`;
}

const ARTIFACT_CHANGE_THRESHOLD = 10;

// Tracks how far the mirrored claude.ai Artifact has drifted from server
// state, so any Claude session can tell (via get_artifact_status) whether
// it's due for a republish -- either a mainquest-level change (status/new
// quest) happened, or enough smaller changes (notes edits, log entries)
// have piled up. Call this from inside a mutateState mutator, once per
// logical change, right after making the change.
export function bumpArtifactChangeCounter(state, { mainQuest = false } = {}) {
  state._artifact = state._artifact ?? { url: null, changesSince: 0, mainQuestChanged: false };
  state._artifact.changesSince += 1;
  if (mainQuest) state._artifact.mainQuestChanged = true;
}

export function artifactNeedsUpdate(state) {
  const a = state._artifact ?? { url: null, changesSince: 0, mainQuestChanged: false };
  return a.url === null || a.mainQuestChanged || a.changesSince >= ARTIFACT_CHANGE_THRESHOLD;
}
