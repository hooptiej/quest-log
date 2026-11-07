#!/usr/bin/env node
// Self-test for ticket-history ordering (#161): "newest" means the latest
// timestamp (when the work happened), everywhere, so a backdated touch (#149)
// lands in its time-ordered spot instead of where it was logged.
//
// Covers all four places that order touches:
//   1. state.js touchesNewestFirst (the rule itself)
//   2. state.js findTicketTouch / update / delete by ticketId ("newest for this ticket")
//   3. the page's renderer (app/public/app.js touchesNewestFirst, extracted
//      from its <touch-order> block and run here)
//   4. the MCP list_ticket_touches tool, against a real server on a temp copy
//
// Usage: node scripts/test-touch-order.mjs   (exits non-zero on any failure)

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendTicketTouch,
  touchesNewestFirst,
  findTicketTouch,
  updateTicketTouch,
  deleteTicketTouch,
} from "../state.js";

let failures = 0;
let passes = 0;
function check(name, ok, detail = "") {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -- ${detail}`}`);
}

const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const notes = (list) => list.map((t) => t.note).join(",");
const fresh = () => ({ quests: [], log: [], ticketTouches: [] });

// Logged in this order: "old" (5 days ago), "now" (just now), then "backdated"
// (2 days ago, but logged LAST). Time order, newest first: now, backdated, old.
function seeded() {
  const s = fresh();
  appendTicketTouch(s, { ticketId: "100", client: "ACME", url: "u", note: "old", timestamp: ago(5) });
  appendTicketTouch(s, { ticketId: "200", client: "ACME", url: "u", note: "now" });
  appendTicketTouch(s, { ticketId: "300", client: "ACME", url: "u", note: "backdated", timestamp: ago(2) });
  return s;
}

// ---- 1. the rule ---------------------------------------------------------
{
  const s = seeded();
  const before = notes(s.ticketTouches);
  check("a backdated touch lands in its time-ordered spot (newest first)", notes(touchesNewestFirst(s.ticketTouches)) === "now,backdated,old", notes(touchesNewestFirst(s.ticketTouches)));
  check("sorting doesn't reorder the stored array", notes(s.ticketTouches) === before, notes(s.ticketTouches));
  const tie = fresh();
  const at = ago(1);
  appendTicketTouch(tie, { ticketId: "1", client: "c", url: "u", note: "first-logged", timestamp: at });
  appendTicketTouch(tie, { ticketId: "2", client: "c", url: "u", note: "second-logged", timestamp: at });
  check("equal timestamps: most recently logged first (the old order)", notes(touchesNewestFirst(tie.ticketTouches)) === "second-logged,first-logged", notes(touchesNewestFirst(tie.ticketTouches)));
  check("bad timestamp sorts oldest instead of throwing", notes(touchesNewestFirst([{ note: "bad", timestamp: "nope" }, { note: "good", timestamp: ago(1) }])) === "good,bad");
  check("empty/missing list -> []", touchesNewestFirst(undefined).length === 0 && touchesNewestFirst([]).length === 0);
}

// ---- 2. "newest for this ticket" in find / update / delete -----------------
{
  const s = fresh();
  // Same ticket twice: the record logged second is backdated to before the first.
  const real = appendTicketTouch(s, { ticketId: "500", client: "ACME", url: "u", note: "worked today" });
  const late = appendTicketTouch(s, { ticketId: "500", client: "ACME", url: "u", note: "logged late, happened last week", timestamp: ago(7) });
  const found = findTicketTouch(s, { ticketId: "500" });
  check("findTicketTouch(ticketId) picks the latest timestamp, not the last logged", found.record?.id === real.id, found.record?.note);
  check("findTicketTouch returns the record's real index in the stored array", s.ticketTouches[found.index]?.id === real.id);
  updateTicketTouch(s, { ticketId: "500" }, { note: "edited" });
  check("update by ticketId edits the latest-timestamp record", real.note === "edited" && late.note === "logged late, happened last week");
  const del = deleteTicketTouch(s, { ticketId: "500" });
  check("delete by ticketId removes the latest-timestamp record", del.record?.id === real.id && s.ticketTouches.length === 1 && s.ticketTouches[0].id === late.id);

  const t = fresh();
  const a = appendTicketTouch(t, { ticketId: "600", client: "c", url: "u", note: "a", timestamp: ago(3) });
  const b = appendTicketTouch(t, { ticketId: "600", client: "c", url: "u", note: "b", timestamp: ago(1) });
  check("before re-dating: newest is b", findTicketTouch(t, { ticketId: "600" }).record?.id === b.id);
  updateTicketTouch(t, { id: a.id }, { timestamp: new Date().toISOString() });
  check("re-dating a record (update with a timestamp) moves it to the top", findTicketTouch(t, { ticketId: "600" }).record?.id === a.id && touchesNewestFirst(t.ticketTouches)[0].id === a.id);

  const tie = fresh();
  const at = ago(1);
  appendTicketTouch(tie, { ticketId: "700", client: "c", url: "u", note: "x", timestamp: at });
  const y = appendTicketTouch(tie, { ticketId: "700", client: "c", url: "u", note: "y", timestamp: at });
  check("tie for one ticket: the later-logged one is 'newest' (same as the list)", findTicketTouch(tie, { ticketId: "700" }).record?.id === y.id);
}

// ---- 3. the page's renderer uses the same order ---------------------------
const here = dirname(fileURLToPath(import.meta.url));
{
  const src = readFileSync(join(here, "..", "app", "public", "app.js"), "utf8");
  const m = /\/\/ <touch-order>[^\n]*\n([\s\S]*?)\/\/ <\/touch-order>/.exec(src);
  check("app.js has the <touch-order> block", !!m);
  check("app.js renders the history through touchesNewestFirst (not slice().reverse())", /touchesNewestFirst\(state\.ticketTouches\)/.test(src) && !/ticketTouches \|\| \[\]\)\.slice\(\)\.reverse\(\)/.test(src));
  if (m) {
    const clientSort = new Function(`${m[1]}\nreturn touchesNewestFirst;`)();
    const s = seeded();
    check("page order: backdated touch in its time-ordered spot", notes(clientSort(s.ticketTouches)) === "now,backdated,old", notes(clientSort(s.ticketTouches)));
    const tie = fresh();
    const at = ago(1);
    appendTicketTouch(tie, { ticketId: "1", client: "c", url: "u", note: "first", timestamp: at });
    appendTicketTouch(tie, { ticketId: "2", client: "c", url: "u", note: "second", timestamp: at });
    appendTicketTouch(tie, { ticketId: "3", client: "c", url: "u", note: "older", timestamp: ago(4) });
    check("page order matches state.js exactly (ties included)", notes(clientSort(tie.ticketTouches)) === notes(touchesNewestFirst(tie.ticketTouches)), `${notes(clientSort(tie.ticketTouches))} vs ${notes(touchesNewestFirst(tie.ticketTouches))}`);
  }
}

// ---- 4. MCP list_ticket_touches on a real server ---------------------------
const tmp = mkdtempSync(join(tmpdir(), "ql-touch-order-"));
const dataPath = join(tmp, "state.json");
writeFileSync(dataPath, JSON.stringify({ ...seeded(), _proMode: true, _version: 1 }, null, 2));
const PORT = 40000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, [join(here, "..", "app", "server.js")], {
  env: { ...process.env, DATA_PATH: dataPath, WRITE_TOKEN: "test-token-161", PORT: String(PORT), DISABLE_TLS: "1", LISTEN_HOST: "127.0.0.1", QUEST_LOG_ENV: "prod" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`${BASE}/health`)).ok; } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  check("server starts on a temp copy", up, serverLog);
  if (up) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client = new Client({ name: "test-touch-order", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
    let r = await client.callTool({ name: "list_ticket_touches", arguments: {} });
    const listed = JSON.parse(r.content[0].text);
    check("MCP list_ticket_touches: backdated touch in its time-ordered spot", notes(listed) === "now,backdated,old", r.content[0].text.slice(0, 300));
    r = await client.callTool({ name: "list_ticket_touches", arguments: { limit: 1 } });
    check("MCP list_ticket_touches limit:1 gives the latest timestamp", JSON.parse(r.content[0].text)[0]?.note === "now", r.content[0].text.slice(0, 200));
    // Backdate over MCP, then check the list moves with it.
    r = await client.callTool({ name: "log_ticket_touch", arguments: { ticketId: "400", client: "ACME", url: "u", note: "very-old", date: ago(10).slice(0, 10) } });
    check("MCP log_ticket_touch with a backdate: ok", !r.isError, r.content?.[0]?.text);
    r = await client.callTool({ name: "list_ticket_touches", arguments: {} });
    check("MCP list after a backdated log: the new touch sorts last, not first", notes(JSON.parse(r.content[0].text)) === "now,backdated,old,very-old", r.content[0].text.slice(0, 300));
    await client.close();
  }
} catch (err) {
  check("server round trip ran without throwing", false, `${err?.stack ?? err}\n--- server output ---\n${serverLog}`);
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 200));
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nall ${passes} passed`);
process.exit(failures ? 1 : 0);
