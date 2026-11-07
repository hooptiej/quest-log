#!/usr/bin/env node
// Self-test for "B succeeds A" (#164): one move that archives A, lifts B to
// A's place, and records the link both ways -- and its undo.
//
// Part 1 calls state.js directly (pure, in memory). Part 2 starts the real
// server on a throwaway copy of the state (a temp dir, a random port) and goes
// through both write paths: POST /api/succeed + /api/undo-succession, and the
// MCP succeed / undo_succession tools over /mcp. Nothing outside the temp dir
// is touched.
//
// Usage: node scripts/test-succession.mjs   (exits non-zero on any failure)

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  succeedQuest,
  undoSuccession,
  deleteQuest,
  validateState,
  recomputeRollups,
} from "../state.js";

let failures = 0;
let passes = 0;
function check(name, ok, detail = "") {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -- ${detail}`}`);
}
const byId = (s, id) => s.quests.find((q) => q.id === id);
const snap = (s) => JSON.stringify(s);

// Q1 (quest)
//   M1 (mission)         <- A in most cases
//     T1 (task)
//   B1 (mission)          <- a successor sitting under A's sibling level
// Q2 (quest)
//   M2 (mission)
//     T2 (task)           <- a successor elsewhere in the tree
//     T3 (task)
// U (ungrouped mission, no parent)
function fixture() {
  return {
    quests: [
      { id: "Q1", title: "Old camera system", status: "progress", level: "quest", parentId: null },
      { id: "M1", title: "Scrypted plugin", status: "progress", level: "mission", parentId: "Q1" },
      { id: "T1", title: "Pair cameras", status: "idea", level: "task", parentId: "M1" },
      { id: "B1", title: "unscrypted bridge", status: "progress", level: "mission", parentId: "Q1" },
      { id: "BT1", title: "Record clips", status: "idea", level: "task", parentId: "B1" },
      { id: "Q2", title: "Home dashboard", status: "progress", level: "quest", parentId: null },
      { id: "M2", title: "Dash lights", status: "progress", level: "mission", parentId: "Q2" },
      { id: "T2", title: "Pulse API", status: "idea", level: "task", parentId: "M2" },
      { id: "T3", title: "Tap to clear", status: "idea", level: "task", parentId: "M2" },
      { id: "U", title: "Loose idea", status: "idea", level: "mission", parentId: null },
    ],
    log: [],
  };
}
const lastLog = (s) => {
  const day = s.log[0];
  const e = day?.entries?.[day.entries.length - 1];
  return typeof e === "string" ? e : e?.text ?? "";
};

// ---- Part 1: state.js -----------------------------------------------------

// 1. B under A: the successor is a child of the quest it replaces.
{
  const s = fixture();
  const r = succeedQuest(s, "B1", "Q1");
  recomputeRollups(s);
  const A = byId(s, "Q1");
  const B = byId(s, "B1");
  check("B under A: no error", !r.error, r.error);
  check("B under A: B lifted to A's level (top-level quest)", B.level === "quest" && B.parentId === null, JSON.stringify(B));
  check("B under A: B's subtree shifts with it (task -> mission)", byId(s, "BT1").level === "mission" && byId(s, "BT1").parentId === "B1", JSON.stringify(byId(s, "BT1")));
  check("B under A: A archived", A.archived === true);
  check("B under A: link recorded on A (succeededBy)", A.succeededBy === "B1");
  check("B under A: link recorded on B (succeeds)", JSON.stringify(B.succeeds) === '["Q1"]', JSON.stringify(B.succeeds));
  check("B under A: A's other children stay under A", byId(s, "M1").parentId === "Q1");
  check("B under A: undo record kept on A", A._succession?.from?.level === "mission" && A._succession?.from?.parentId === "Q1" && A._succession?.wasArchived === false, JSON.stringify(A._succession));
  check("B under A: one mission-log line", s.log.length === 1 && s.log[0].entries.length === 1 && /succeeds "Old camera system"/.test(lastLog(s)), lastLog(s));
  check("B under A: result lists the moved subtree", JSON.stringify(r.moved) === '["B1","BT1"]', JSON.stringify(r.moved));
  check("B under A: state still validates", validateState(s) === null, validateState(s));
}

// 2. B elsewhere in the tree: a task under another quest takes a mission's place.
{
  const s = fixture();
  const r = succeedQuest(s, "T2", "M1");
  const B = byId(s, "T2");
  check("B elsewhere: no error", !r.error, r.error);
  check("B elsewhere: B becomes a mission under A's parent", B.level === "mission" && B.parentId === "Q1", JSON.stringify(B));
  check("B elsewhere: its old sibling is untouched", byId(s, "T3").parentId === "M2" && byId(s, "T3").level === "task");
  check("B elsewhere: A archived + linked", byId(s, "M1").archived === true && byId(s, "M1").succeededBy === "T2" && B.succeeds?.[0] === "M1");
  check("B elsewhere: log says where it moved from and to", /moved from a task under "Dash lights" to a mission under "Old camera system"/.test(r.summary), r.summary);
  check("B elsewhere: state still validates", validateState(s) === null, validateState(s));
}

// 3. A is an ungrouped (parentless) mission: B lands as a parentless MISSION,
//    not a Quest (which is what `move` with no parent would give).
{
  const s = fixture();
  const r = succeedQuest(s, "T3", "U");
  const B = byId(s, "T3");
  check("ungrouped A: B becomes a parentless mission", !r.error && B.level === "mission" && B.parentId === null, r.error || JSON.stringify(B));
  check("ungrouped A: state still validates", validateState(s) === null, validateState(s));
}

// 4. Titles resolve like every other tool (exact or substring).
{
  const s = fixture();
  const r = succeedQuest(s, "unscrypted", "Old camera");
  check("resolves successor/predecessor by title", !r.error && byId(s, "Q1").succeededBy === "B1", r.error);
}

// 5. Refusals change nothing at all.
function refuses(name, mutate, setup, pattern) {
  const s = fixture();
  if (setup) setup(s);
  const before = snap(s);
  const r = mutate(s);
  check(`refuses: ${name}`, !!r.error && (!pattern || pattern.test(r.error)), r.error ?? "no error returned");
  check(`refuses: ${name} -- state unchanged`, snap(s) === before);
  check(`refuses: ${name} -- error says nothing changed`, /Nothing was changed/.test(r.error ?? ""), r.error);
}
refuses("B == A", (s) => succeedQuest(s, "M1", "M1"), null, /can't succeed itself/);
refuses("B is A's parent", (s) => succeedQuest(s, "M1", "T1"), null, /ancestor/);
refuses("B is A's grandparent", (s) => succeedQuest(s, "Q1", "T1"), null, /ancestor/);
refuses("A already has a successor", (s) => succeedQuest(s, "T3", "M1"), (s) => succeedQuest(s, "T2", "M1"), /already succeeded by/);
refuses("B is archived", (s) => succeedQuest(s, "U", "M1"), (s) => { byId(s, "U").archived = true; }, /archived/);
refuses("succession chain would loop", (s) => succeedQuest(s, "M1", "B1"), (s) => {
  // B1 succeeded M1 earlier; M1 was unarchived since. M1 succeeding B1 would loop.
  succeedQuest(s, "B1", "M1");
  delete byId(s, "M1").archived;
}, /loop/);
refuses("subtree would go past Task", (s) => succeedQuest(s, "Q2", "M1"), null, /past Task/);
refuses("unknown successor", (s) => succeedQuest(s, "no-such-thing", "M1"), null, /Successor: No quest found/);
refuses("unknown predecessor", (s) => succeedQuest(s, "B1", "no-such-thing"), null, /Predecessor: No quest found/);

// 6. Undo puts everything back exactly.
{
  const s = fixture();
  const original = fixture();
  succeedQuest(s, "B1", "Q1");
  const u = undoSuccession(s, "Q1");
  recomputeRollups(s);
  check("undo: no error", !u.error, u.error);
  const placement = (st) => JSON.stringify(st.quests.map((q) => [q.id, q.level, q.parentId ?? null, !!q.archived, q.succeeds ?? null, q.succeededBy ?? null, q._succession ?? null]));
  check("undo: every item's level/parent/archive/link is back to the start", placement(s) === placement(original), placement(s));
  check("undo: restoredPlacement reported", u.restoredPlacement === true);
  check("undo: logged too (two lines now)", s.log[0].entries.length === 2 && /Succession undone/.test(lastLog(s)), lastLog(s));
}
{
  const s = fixture();
  byId(s, "M1").archived = true; // already archived before the succession
  succeedQuest(s, "T2", "M1");
  undoSuccession(s, "M1");
  check("undo: an already-archived predecessor stays archived", byId(s, "M1").archived === true && !byId(s, "M1").succeededBy);
}
{
  const s = fixture();
  succeedQuest(s, "T2", "M1");
  // Someone moves the successor afterwards.
  byId(s, "T2").parentId = "Q2";
  const before = snap(s);
  const u = undoSuccession(s, "M1");
  check("undo: refuses when the successor moved since", !!u.error && /has moved since/.test(u.error), u.error);
  check("undo: that refusal changes nothing", snap(s) === before);
  const k = undoSuccession(s, "M1", { keepPlacement: true });
  check("undo keepPlacement: drops link + unarchives, leaves B where it is", !k.error && !byId(s, "M1").archived && !byId(s, "M1").succeededBy && !byId(s, "T2").succeeds && byId(s, "T2").parentId === "Q2", k.error || JSON.stringify(byId(s, "T2")));
}
{
  const s = fixture();
  const u = undoSuccession(s, "M1");
  check("undo: refuses when nothing succeeded it", !!u.error && /nothing to undo/.test(u.error), u.error);
  succeedQuest(s, "B1", "Q1");
  const w = undoSuccession(s, "B1");
  check("undo: naming the successor by mistake says so", !!w.error && /is the successor here/.test(w.error), w.error);
}

// 7. One successor can replace several things.
{
  const s = fixture();
  succeedQuest(s, "B1", "M1");
  succeedQuest(s, "B1", "U");
  check("one successor, two predecessors: succeeds lists both", JSON.stringify(byId(s, "B1").succeeds) === '["M1","U"]', JSON.stringify(byId(s, "B1").succeeds));
  check("...and the latest move wins its placement (parentless mission)", byId(s, "B1").level === "mission" && byId(s, "B1").parentId === null);
}

// 8. Deleting one side cleans the link off the other.
{
  const s = fixture();
  succeedQuest(s, "T2", "M1");
  deleteQuest(s, "T2");
  const A = byId(s, "M1");
  check("delete successor: predecessor's succeededBy + undo record dropped, still archived", !A.succeededBy && !A._succession && A.archived === true, JSON.stringify(A));
  const s2 = fixture();
  succeedQuest(s2, "T2", "U");
  deleteQuest(s2, "U");
  check("delete predecessor: successor's succeeds dropped", byId(s2, "T2").succeeds === undefined, JSON.stringify(byId(s2, "T2")));
}

// 9. Validation of the new fields.
{
  const s = fixture();
  byId(s, "M1").succeededBy = 42;
  check("validateState rejects a non-string succeededBy", validateState(s) !== null);
  const s2 = fixture();
  byId(s2, "M1").succeeds = ["ok", ""];
  check("validateState rejects an empty id in succeeds", validateState(s2) !== null);
}

// ---- Part 2: the real server, both write paths ----------------------------

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "ql-succession-"));
const dataPath = join(tmp, "state.json");
writeFileSync(dataPath, JSON.stringify({ ...fixture(), _version: 1 }, null, 2));
const TOKEN = "test-token-164";
const PORT = 40000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const readDisk = () => JSON.parse(readFileSync(dataPath, "utf8"));

const server = spawn(process.execPath, [join(here, "..", "app", "server.js")], {
  env: { ...process.env, DATA_PATH: dataPath, WRITE_TOKEN: TOKEN, PORT: String(PORT), DISABLE_TLS: "1", LISTEN_HOST: "127.0.0.1", QUEST_LOG_ENV: "prod" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((res) => setTimeout(res, 100));
  }
  return false;
}
const post = (path, body, token = TOKEN) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-write-token": token } : {}) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));

try {
  const up = await waitForServer();
  check("server starts on a temp copy", up, serverLog);
  if (up) {
    let r = await post("/api/succeed", { successor: "B1", predecessor: "Q1" }, null);
    check("HTTP: no write token -> 401", r.status === 401, JSON.stringify(r));
    r = await post("/api/succeed", { successor: "B1" });
    check("HTTP: missing predecessor -> 400 that says what to send", r.status === 400 && /predecessor/.test(r.json.error), JSON.stringify(r));

    const v0 = readDisk()._version;
    r = await post("/api/succeed", { successor: "B1", predecessor: "Q1", dryRun: true });
    check("HTTP dryRun: 200, wrote:false, says what would happen", r.status === 200 && r.json.wrote === false && /succeeds "Old camera system"/.test(r.json.summary), JSON.stringify(r));
    check("HTTP dryRun: nothing on disk changed", readDisk()._version === v0 && !byId(readDisk(), "Q1").archived);

    r = await post("/api/succeed", { successor: "B1", predecessor: "Q1" });
    const d1 = readDisk();
    check("HTTP succeed: 200 with the new version", r.status === 200 && r.json.wrote === true && r.json.version === v0 + 1 && d1._version === v0 + 1, JSON.stringify(r));
    check("HTTP succeed: on disk A archived + linked, B lifted", byId(d1, "Q1").archived === true && byId(d1, "Q1").succeededBy === "B1" && byId(d1, "B1").level === "quest" && byId(d1, "B1").succeeds?.[0] === "Q1");
    check("HTTP succeed: on disk state validates", validateState(d1) === null, validateState(d1));

    r = await post("/api/succeed", { successor: "T2", predecessor: "Q1" });
    check("HTTP refusal: 400 with a clear reason", r.status === 400 && /already succeeded by/.test(r.json.error), JSON.stringify(r));
    check("HTTP refusal: no save, version unchanged", readDisk()._version === v0 + 1);

    // MCP: list the tools, undo over MCP, then succeed again over MCP.
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client = new Client({ name: "test-succession", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    check("MCP: succeed and undo_succession are listed", tools.includes("succeed") && tools.includes("undo_succession"), tools.join(","));

    let m = await client.callTool({ name: "undo_succession", arguments: { idOrTitle: "Q1" } });
    const d2 = readDisk();
    check("MCP undo_succession: ok", !m.isError, m.content?.[0]?.text);
    check("MCP undo_succession: B back under A as a mission, A unarchived, links gone", byId(d2, "B1").level === "mission" && byId(d2, "B1").parentId === "Q1" && byId(d2, "BT1").level === "task" && !byId(d2, "Q1").archived && !byId(d2, "Q1").succeededBy && !byId(d2, "B1").succeeds, JSON.stringify(byId(d2, "B1")));

    m = await client.callTool({ name: "succeed", arguments: { idOrTitle: "T2", predecessorIdOrTitle: "M1" } });
    const d3 = readDisk();
    check("MCP succeed: ok, B elsewhere lifted into A's slot", !m.isError && byId(d3, "T2").level === "mission" && byId(d3, "T2").parentId === "Q1" && byId(d3, "M1").succeededBy === "T2", m.content?.[0]?.text);

    const vBefore = d3._version;
    m = await client.callTool({ name: "succeed", arguments: { idOrTitle: "M1", predecessorIdOrTitle: "M1" } });
    check("MCP refusal: isError with the reason, no save", m.isError === true && /can't succeed itself/.test(m.content?.[0]?.text) && readDisk()._version === vBefore, m.content?.[0]?.text);

    m = await client.callTool({ name: "list_quests", arguments: { archived: true, summary: true } });
    const archivedList = JSON.parse(m.content[m.content.length - 1].text);
    check("MCP list_quests(archived:true) shows the predecessor's succeededBy", archivedList.some((q) => q.id === "M1" && q.succeededBy === "T2"), m.content?.[0]?.text?.slice(0, 300));

    await client.close();

    const page = await fetch(`${BASE}/`).then((x) => x.text());
    check("page still renders after a succession", page.includes("succeeds") || page.includes("T2"), page.slice(0, 200));
  }
} catch (err) {
  check("server round trip ran without throwing", false, `${err?.stack ?? err}\n--- server output ---\n${serverLog}`);
} finally {
  server.kill();
  await new Promise((res) => setTimeout(res, 200));
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nall ${passes} passed`);
process.exit(failures ? 1 : 0);
