// #138: archiving a done child must not change its parent's progress numbers.
// Extracts the real counting functions out of app/public/app.js (it is browser code, not a module)
// and exercises them against a small tree before and after archiving the done children.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// APP_JS lets a caller point the test at a modified copy (to prove the test fails without the fix).
const src = readFileSync(process.env.APP_JS || join(here, "..", "app", "public", "app.js"), "utf8");

function slice(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error(`could not find ${startMarker} .. ${endMarker} in app.js`);
  return src.slice(a, b);
}

const code = [
  slice("  function getDescendants(", "  // Notes-disclosure rollup"),
  slice("  var fullQuestList = null;", "  // Computes done/total"),
  slice("  function childCountLabel(", "  // Used by treeNode"),
].join("\n");
// order matters: fullQuestList must exist before the functions read it
const factory = new Function(
  `var fullQuestList = null;
   ${code.replace("var fullQuestList = null;", "")}
   return { questProgress, childCountLabel, setFull: function (v) { fullQuestList = v; } };`
);
const api = factory();

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  if (!ok) failed++;
}

const quests = [
  { id: "q", level: "quest", status: "progress", parentId: null },
  { id: "m1", level: "mission", status: "done", parentId: "q" },
  { id: "m2", level: "mission", status: "done", parentId: "q" },
  { id: "m3", level: "mission", status: "progress", parentId: "q" },
  { id: "t1", level: "task", status: "done", parentId: "m3" },
  { id: "t2", level: "task", status: "idea", parentId: "m3" },
];
const q = quests[0];
const visible = (list) => list.filter((x) => !x.archived);

console.log("before archiving:");
api.setFull(quests);
check("progress", api.questProgress(q, visible(quests)), { done: 3, total: 6, pct: 50 });
check("badge", api.childCountLabel(q, visible(quests).filter((x) => x.parentId === "q")), "3 missions, 2 done");

console.log("after archiving the done children (m1, m2, t1):");
for (const id of ["m1", "m2", "t1"]) quests.find((x) => x.id === id).archived = true;
check("progress is unchanged", api.questProgress(q, visible(quests)), { done: 3, total: 6, pct: 50 });
check("badge is unchanged", api.childCountLabel(q, visible(quests).filter((x) => x.parentId === "q")), "3 missions, 2 done");

console.log("without the full list (fallback path still works):");
api.setFull(null);
check("progress falls back to what it is given", api.questProgress(q, visible(quests)).total, 3);

console.log(failed ? `\nFAILED: ${failed}` : "\nAll progress/archive tests passed!");
process.exit(failed ? 1 : 0);
