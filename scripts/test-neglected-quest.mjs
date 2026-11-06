// most-neglected top-level Quest (#62, fixed #162): the longest-untouched OPEN
// top-level Quest. done/archived are excluded; blocked stays eligible.
//   node scripts/test-neglected-quest.mjs
import { mostNeglectedTopLevelQuest } from "../state.js";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
const idOf = (q) => (q ? q.id : null);

// A done Quest with the oldest lastTouchedAt must NOT win; the oldest OPEN one does.
let quests = [
  { id: "doneOld", level: "quest", parentId: null, status: "done", lastTouchedAt: "2026-10-01T00:00:00Z" },
  { id: "openMid", level: "quest", parentId: null, status: "progress", lastTouchedAt: "2026-10-10T00:00:00Z" },
  { id: "openNew", level: "quest", parentId: null, status: "idea", lastTouchedAt: "2026-10-20T00:00:00Z" },
];
check("done quest is not 'most neglected' even when oldest", idOf(mostNeglectedTopLevelQuest(quests)) === "openMid", idOf(mostNeglectedTopLevelQuest(quests)));

// Archived Quests are excluded too, even if open-status and oldest.
quests = [
  { id: "archOld", level: "quest", parentId: null, status: "progress", archived: true, lastTouchedAt: "2026-09-01T00:00:00Z" },
  { id: "openOnly", level: "quest", parentId: null, status: "progress", lastTouchedAt: "2026-10-05T00:00:00Z" },
];
check("archived quest is excluded", idOf(mostNeglectedTopLevelQuest(quests)) === "openOnly", idOf(mostNeglectedTopLevelQuest(quests)));

// A blocked Quest stays eligible -- blocked is exactly the neglect worth surfacing.
quests = [
  { id: "blockedOld", level: "quest", parentId: null, status: "progress", blocked: true, lastTouchedAt: "2026-10-01T00:00:00Z" },
  { id: "openNewer", level: "quest", parentId: null, status: "progress", lastTouchedAt: "2026-10-15T00:00:00Z" },
];
check("blocked quest stays eligible and can be most-neglected", idOf(mostNeglectedTopLevelQuest(quests)) === "blockedOld", idOf(mostNeglectedTopLevelQuest(quests)));

// A missing lastTouchedAt sorts oldest ("never touched").
quests = [
  { id: "touched", level: "quest", parentId: null, status: "progress", lastTouchedAt: "2026-10-01T00:00:00Z" },
  { id: "never", level: "quest", parentId: null, status: "progress" },
];
check("never-touched (no lastTouchedAt) sorts oldest", idOf(mostNeglectedTopLevelQuest(quests)) === "never", idOf(mostNeglectedTopLevelQuest(quests)));

// Only top-level Quests count: a stale child mission/task is ignored.
quests = [
  { id: "childOld", level: "mission", parentId: "p", status: "progress", lastTouchedAt: "2026-09-01T00:00:00Z" },
  { id: "topNewer", level: "quest", parentId: null, status: "progress", lastTouchedAt: "2026-10-01T00:00:00Z" },
];
check("non-top-level items are ignored", idOf(mostNeglectedTopLevelQuest(quests)) === "topNewer", idOf(mostNeglectedTopLevelQuest(quests)));

// No open top-level Quest -> null (boot-bar line hides, server returns null).
check("all done/archived -> null", mostNeglectedTopLevelQuest([
  { id: "d", level: "quest", parentId: null, status: "done", lastTouchedAt: "2026-10-01T00:00:00Z" },
  { id: "a", level: "quest", parentId: null, status: "progress", archived: true, lastTouchedAt: "2026-10-02T00:00:00Z" },
]) === null, "expected null");
check("empty list -> null", mostNeglectedTopLevelQuest([]) === null, "expected null");
check("undefined -> null (no throw)", mostNeglectedTopLevelQuest(undefined) === null, "expected null");

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
