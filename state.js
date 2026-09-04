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

export function nowISO() {
  return new Date().toISOString();
}

export function slugify(title) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "idea"}-${Date.now().toString(36)}`;
}

// "blocked" used to be a status (#26); it's now an independent flag (see
// setBlocked below) so a quest can be "in progress but blocked" without
// losing its real status.
const VALID_STATUSES = new Set(["idea", "progress", "done"]);
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
    (q.parentId === null || q.parentId === undefined || typeof q.parentId === "string") &&
    // Same convention as readyToClose: absence means false, never stored as false.
    (q.blocked === undefined || q.blocked === true) &&
    (q.archived === undefined || q.archived === true) &&
    (q.attention === undefined || q.attention === true) &&
    (q.blockedByDescendant === undefined || q.blockedByDescendant === true) &&
    // createdAt and lastTouchedAt are optional but must be ISO timestamp strings if present
    (q.createdAt === undefined || typeof q.createdAt === "string") &&
    (q.lastTouchedAt === undefined || typeof q.lastTouchedAt === "string") &&
    // #64: optional structured link to the GitHub issue this quest tracks
    // (e.g. one item in a serialized batch run) -- "owner/repo" string plus
    // its issue number. Both optional, but if either is present the pairing
    // should make sense; not strictly enforced here (a lone issueNumber
    // with no repo is still valid, just less useful) to keep validation
    // simple and match how every other optional field on a quest works.
    (q.repo === undefined || typeof q.repo === "string") &&
    (q.issueNumber === undefined || typeof q.issueNumber === "number")
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
//
// The same two passes also flow "blocked" uphill (#26): blockedByDescendant
// is set on a parent whenever any child is itself blocked or already
// carries the flag from further down -- so a blocked Task marks its Mission,
// which in turn marks its Quest. This is purely derived (never set by a
// tool directly, only ever by this function), so it can't drift from the
// real per-item `blocked` flags it's summarizing.
export function recomputeRollups(state) {
  for (const level of ["mission", "quest"]) {
    for (const parent of state.quests) {
      if (parent.level !== level) continue;
      const children = state.quests.filter((c) => c.parentId === parent.id);
      if (children.length === 0) {
        delete parent.readyToClose;
        delete parent.blockedByDescendant;
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
      if (children.some((c) => c.blocked || c.blockedByDescendant)) parent.blockedByDescendant = true;
      else delete parent.blockedByDescendant;
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
  delete quest.blocked; // done implies no longer blocked
  recomputeRollups(state);
  return { quest };
}

// Retitles an existing quest/mission/task in place, independent of any level
// change (#24) -- promote keeps a title verbatim when leveling something up,
// so there was previously no way to fix a title that no longer reads as a
// good umbrella name after a restructure without deleting and recreating it.
export function renameQuest(state, idOrTitle, newTitle) {
  const resolved = resolveOne(state, idOrTitle);
  if (resolved.error) return resolved;
  const title = (newTitle ?? "").trim();
  if (!title) return { error: "newTitle can't be empty" };
  resolved.quest.title = title;
  return { quest: resolved.quest };
}

// Sets the quest log's Designation/name (#33). Used to live only in browser
// localStorage, editable once via the header field before it locked itself
// read-only -- moved server-side so an MCP tool can change it afterward
// instead of the field needing to stay editable.
export function setDesignation(state, name) {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return { error: "name can't be empty" };
  state.designation = trimmed;
  return { designation: trimmed };
}

// Sets or clears the independent "blocked" flag (#26) on any quest, at any
// level -- a Task, an in-progress Mission, anything. Kept separate from
// status entirely: blocking something doesn't change what it's actively
// doing, it just flags that something's in the way.
export function setBlocked(state, idOrTitle, blocked) {
  const resolved = resolveOne(state, idOrTitle);
  if (resolved.error) return resolved;
  const quest = resolved.quest;
  if (blocked) quest.blocked = true;
  else delete quest.blocked;
  return { quest };
}

// Sets or clears the independent "archived" flag on any quest, at any level.
// Archived items are genuinely hidden from the default view, distinct from
// "done" items which are sorted to the bottom and grouped in a collapsed
// Completed section. Follows the exact same pattern as setBlocked.
export function setArchived(state, idOrTitle, archived) {
  const resolved = resolveOne(state, idOrTitle);
  if (resolved.error) return resolved;
  const quest = resolved.quest;
  if (archived) quest.archived = true;
  else delete quest.archived;
  return { quest };
}

// Sets or clears the independent "attention" flag on any quest, at any level.
// Attention-flagged items are surfaced in read-tool outputs as items needing
// active follow-up, a deliberate manual flag distinct from #44's auto-set
// "unread" marker. Follows the exact same pattern as setBlocked/setArchived.
export function setAttention(state, idOrTitle, attention) {
  const resolved = resolveOne(state, idOrTitle);
  if (resolved.error) return resolved;
  const quest = resolved.quest;
  if (attention) quest.attention = true;
  else delete quest.attention;
  return { quest };
}

// Bumps lastTouchedAt on the top-level Quest ancestor of the given quest
// (or on the quest itself if it's already a top-level Quest), setting it to
// the current ISO timestamp. This is called after any meaningful mutation to
// ensure the root quest's "last touched" time accurately reflects activity
// anywhere in its subtree.
export function touchQuestAncestor(state, questOrId) {
  // If questOrId is a string (id), find the quest object
  const quest = typeof questOrId === "string"
    ? state.quests.find((q) => q.id === questOrId)
    : questOrId;

  if (!quest) return;

  // Walk up the parentId chain to find the top-level Quest ancestor
  let current = quest;
  while (current.parentId) {
    const parent = state.quests.find((q) => q.id === current.parentId);
    if (!parent) break;
    current = parent;
  }

  // Touch the top-level Quest ancestor (or the quest itself if it's already top-level)
  current.lastTouchedAt = nowISO();
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

// Lets a human flag an upcoming/in-progress redeploy before it happens, so an
// already-open MCP session can warn the user ahead of time instead of just
// hitting the opaque "no valid session" error once the container actually
// restarts (sessions are in-memory and don't survive a restart regardless --
// this flag doesn't prevent that, it just makes the read tools mention it).
export function getMaintenance(state) {
  return state._maintenance ?? { active: false, note: "", since: null };
}

export function setMaintenance(state, { active, note }) {
  state._maintenance = active ? { active: true, note: note ?? "", since: new Date().toISOString() } : { active: false, note: "", since: null };
  return state._maintenance;
}

// The level directly above/below each tier, for promote (up) and recruit
// (down). There's no entry for the ends (promoting a quest, recruiting a
// task) -- callers check for that themselves and reject with a clearer
// message than a missing-key lookup would give.
const LEVEL_UP = { task: "mission", mission: "quest" };
const LEVEL_DOWN = { quest: "mission", mission: "task" };

// Levels a Task up to a Mission, or a Mission up to a Quest, "in place": it
// becomes a sibling of its former parent (same grandparent), except at the
// Quest ceiling, where there's no grandparent tier to land under so it goes
// top-level. Refuses if the item has children -- promoting a Mission with
// Tasks under it would leave those Tasks pointed at a Quest, which nothing
// in this schema allows (a task's parent must be a mission) -- so the
// children need to be dealt with (promoted or reparented) first.
export function promoteQuest(state, idOrTitle) {
  const resolved = resolveOne(state, idOrTitle);
  if (resolved.error) return resolved;
  const quest = resolved.quest;
  const newLevel = LEVEL_UP[quest.level];
  if (!newLevel) return { error: `${describeQuest(quest)} is already a Quest -- nothing to promote it to` };
  const hasChildren = state.quests.some((c) => c.parentId === quest.id);
  if (hasChildren) {
    return { error: `${describeQuest(quest)} still has children -- promote or transfer them first, then promote this` };
  }
  const oldParent = quest.parentId ? state.quests.find((q) => q.id === quest.parentId) : null;
  quest.level = newLevel;
  quest.parentId = newLevel === "quest" ? null : oldParent?.parentId ?? null;
  return { quest };
}

// Brings an existing top-level (parentless) Quest in as a Mission under
// another Quest, or an existing top-level Mission in as a Task under another
// Mission -- i.e. the level-losing counterpart to promote. Only works on
// something both parentless (already has a parent -- that's Transfer's job)
// and childless: recruiting a Quest that has Missions under it, or a Mission
// that has Tasks under it, would leave those children one tier too deep for
// this schema's fixed 3-tier depth (nothing can be parented by a Task).
export function recruitQuest(state, idOrTitle, newParentIdOrTitle) {
  const resolved = resolveOne(state, idOrTitle);
  if (resolved.error) return resolved;
  const quest = resolved.quest;
  if (quest.parentId) {
    return { error: `${describeQuest(quest)} already has a parent -- use transfer to move it, not recruit` };
  }
  const newLevel = LEVEL_DOWN[quest.level];
  if (!newLevel) return { error: `${describeQuest(quest)} is already a Task -- nothing to recruit it as` };
  if (!newParentIdOrTitle) return { error: "recruit needs a newParentIdOrTitle to recruit into" };
  const hasChildren = state.quests.some((c) => c.parentId === quest.id);
  if (hasChildren) {
    return { error: `${describeQuest(quest)} still has children -- they'd have nowhere valid to go as a ${newLevel}'s children -- reparent or remove them first` };
  }
  const parentResolution = resolveParent(state, newParentIdOrTitle, newLevel);
  if (parentResolution.error) return parentResolution;
  if (parentResolution.parentId === quest.id) return { error: `${describeQuest(quest)} can't be its own parent` };
  quest.level = newLevel;
  quest.parentId = parentResolution.parentId;
  return { quest };
}

// Moves a Mission to a different Quest, or a Task to a different Mission --
// same level, new parent. A Quest can't be transferred (nothing above it to
// move it under; recruit an existing Quest into another one instead). A
// Task is locked to its current Quest family: it may only transfer to a
// Mission that's under the same Quest it's under now (or anywhere, if it
// isn't currently under any Quest at all -- there's no family to violate).
export function transferQuest(state, idOrTitle, newParentIdOrTitle) {
  const resolved = resolveOne(state, idOrTitle);
  if (resolved.error) return resolved;
  const quest = resolved.quest;
  if (quest.level === "quest") {
    return { error: `${describeQuest(quest)} is a Quest -- transfer only moves Missions/Tasks (recruit an existing Quest into another one instead)` };
  }
  if (!newParentIdOrTitle) return { error: "transfer needs a newParentIdOrTitle to move to" };
  // No explicit self-parent check needed here (unlike recruit): transfer
  // never changes level, and no level is its own required parent tier
  // (PARENT_LEVEL has no fixed point), so a self-reference always fails the
  // tier check inside resolveParent below before it could matter.
  const parentResolution = resolveParent(state, newParentIdOrTitle, quest.level);
  if (parentResolution.error) return parentResolution;

  if (quest.level === "task" && quest.parentId) {
    const currentMission = state.quests.find((q) => q.id === quest.parentId);
    const currentQuestId = currentMission?.parentId ?? null;
    if (currentQuestId) {
      const targetMission = state.quests.find((q) => q.id === parentResolution.parentId);
      if (targetMission?.parentId !== currentQuestId) {
        return { error: `${describeQuest(quest)} can only transfer to a Mission under its current Quest -- cross-Quest Task moves aren't allowed` };
      }
    }
  }

  quest.parentId = parentResolution.parentId;
  return { quest };
}

// Removes a quest/mission/task outright. Refuses if it has children unless
// cascade is set, since silently orphaning children would leave them
// pointed at a parentId that no longer exists (validateState would then
// reject the very next read). With cascade, the whole subtree goes together
// and every removed id is reported so the caller can say what was lost.
export function deleteQuest(state, idOrTitle, { cascade = false } = {}) {
  const resolved = resolveOne(state, idOrTitle);
  if (resolved.error) return resolved;
  const quest = resolved.quest;

  const collectDescendants = (parentId) => {
    const direct = state.quests.filter((c) => c.parentId === parentId);
    return direct.flatMap((c) => [c, ...collectDescendants(c.id)]);
  };
  const descendants = collectDescendants(quest.id);

  if (descendants.length > 0 && !cascade) {
    return {
      error: `${describeQuest(quest)} has ${descendants.length} child${descendants.length === 1 ? "" : "ren"} -- pass cascade:true to delete them too, or reparent/delete them first`,
    };
  }

  const removedIds = new Set([quest.id, ...descendants.map((d) => d.id)]);
  state.quests = state.quests.filter((q) => !removedIds.has(q.id));
  return { quest, deleted: [...removedIds] };
}

// Fixed tier order (index 0..2) used by moveQuest to compute level shifts --
// LEVEL_UP/LEVEL_DOWN above are only defined pairwise and don't give an easy
// way to shift a whole subtree by N tiers at once.
const LEVEL_ORDER = ["quest", "mission", "task"];

// Moves an item -- and its whole subtree, whatever shape it is -- to become
// a child of a new parent, regardless of the item's current level, parent,
// or children. This is the general "just move it here" tool that
// promote/recruit/transfer don't cover between them: recruit needs the item
// both childless and parentless, transfer keeps the same level, and promote
// never reparents. The new level for the moved root is derived from the new
// parent's level (one tier down), and every descendant shifts by the same
// number of tiers to preserve the subtree's shape. Omitting
// newParentIdOrTitle moves the item to top-level, as a Quest.
// Only rejected when the shift would push some descendant past the fixed
// 3-tier floor/ceiling (nothing can be a Quest's parent, nothing can be a
// Task's child) -- that failure names the offending descendant so the
// caller knows what to deal with first.
export function moveQuest(state, idOrTitle, newParentIdOrTitle) {
  const resolved = resolveOne(state, idOrTitle);
  if (resolved.error) return resolved;
  const quest = resolved.quest;

  let newParent = null;
  if (newParentIdOrTitle) {
    const parentResolved = resolveOne(state, newParentIdOrTitle);
    if (parentResolved.error) return parentResolved;
    newParent = parentResolved.quest;
    if (newParent.id === quest.id) return { error: `${describeQuest(quest)} can't be its own parent` };
    if (newParent.level === "task") {
      return { error: `${describeQuest(newParent)} is a Task -- Tasks can't have children, so nothing can move under it` };
    }
  }

  const collectDescendants = (parentId) => {
    const direct = state.quests.filter((c) => c.parentId === parentId);
    return direct.flatMap((c) => [c, ...collectDescendants(c.id)]);
  };
  const descendants = collectDescendants(quest.id);

  if (newParent && descendants.some((d) => d.id === newParent.id)) {
    return { error: `${describeQuest(newParent)} is inside ${describeQuest(quest)}'s own subtree -- can't move something under its own descendant` };
  }

  const newRootLevel = newParent ? LEVEL_DOWN[newParent.level] : "quest";
  const delta = LEVEL_ORDER.indexOf(newRootLevel) - LEVEL_ORDER.indexOf(quest.level);

  const maxDescendantDepth = (id) => {
    const kids = state.quests.filter((c) => c.parentId === id);
    if (kids.length === 0) return 0;
    return 1 + Math.max(...kids.map((k) => maxDescendantDepth(k.id)));
  };
  const subtreeDepth = maxDescendantDepth(quest.id);
  if (LEVEL_ORDER.indexOf(newRootLevel) + subtreeDepth > LEVEL_ORDER.length - 1) {
    return {
      error: `moving ${describeQuest(quest)} ${newParent ? `under ${describeQuest(newParent)}` : "to top-level"} would push its deepest descendant past Task -- promote or reparent that part of the subtree first`,
    };
  }

  quest.level = newRootLevel;
  quest.parentId = newParent ? newParent.id : null;
  for (const d of descendants) {
    d.level = LEVEL_ORDER[LEVEL_ORDER.indexOf(d.level) + delta];
  }

  return { quest, moved: [quest.id, ...descendants.map((d) => d.id)] };
}
