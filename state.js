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

export function isValidQuest(q) {
  return (
    q &&
    typeof q === "object" &&
    typeof q.id === "string" &&
    q.id.length > 0 &&
    typeof q.title === "string" &&
    q.title.length > 0 &&
    VALID_STATUSES.has(q.status)
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
  return null;
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
