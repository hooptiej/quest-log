#!/usr/bin/env node
// Self-test for editing/deleting ticket-touch records (#134).
//
// Ticket-touch records used to be append-only with no id, so a wrong URL or
// a duplicate could only be "fixed" by logging another touch. This checks
// the new state.js functions directly (no server, no MCP session): ids are
// assigned and backfilled, update/delete target by id or newest-by-ticketId,
// a quest's haloTickets reference follows a url/client correction, and
// attach/detach behave. Pure in-memory -- nothing is written anywhere.
//
// Usage: node scripts/test-ticket-touch-edits.mjs
// Prints PASS/FAIL per case and a summary line.

import {
  appendTicketTouch,
  ensureTicketTouchIds,
  updateTicketTouch,
  deleteTicketTouch,
  attachHaloTicket,
  detachHaloTicket,
  validateState,
} from "../state.js";

const results = [];
function check(desc, cond, detail = "") {
  results.push({ desc, ok: !!cond, detail });
}

function freshState() {
  return {
    quests: [{ id: "q1", title: "Quest", status: "idea", level: "mission", parentId: null }],
    log: [],
    ticketTouches: [],
  };
}

// --- ids ---
{
  const s = freshState();
  const r = appendTicketTouch(s, { ticketId: "100", client: "ACME", url: "https://bad/100", note: "n" });
  check("new touch record gets an id", typeof r.id === "string" && r.id.length > 0);
  const r2 = appendTicketTouch(s, { ticketId: "100", client: "ACME", url: "https://bad/100", note: "n2" });
  check("ids are unique", r.id !== r2.id);
}
{
  const s = freshState();
  s.ticketTouches.push({ ticketId: "7", client: "OLD", url: "u", note: "pre-#134", timestamp: new Date().toISOString(), closedWithHelp: false });
  ensureTicketTouchIds(s);
  const firstId = s.ticketTouches[0].id;
  ensureTicketTouchIds(s);
  check("pre-#134 record gets an id backfilled", typeof firstId === "string" && firstId.length > 0);
  check("backfill is stable (doesn't re-assign)", s.ticketTouches[0].id === firstId);
}

// --- update ---
{
  const s = freshState();
  const a = appendTicketTouch(s, { ticketId: "200", client: "ACME", url: "https://bad/200", note: "first" });
  const b = appendTicketTouch(s, { ticketId: "200", client: "ACME", url: "https://bad/200", note: "second" });
  const res = updateTicketTouch(s, { ticketId: "200" }, { url: "https://good/200" });
  check("update by ticketId targets the NEWEST record", res.record?.id === b.id && b.url === "https://good/200");
  check("update by ticketId leaves older record alone", a.url === "https://bad/200");
  updateTicketTouch(s, { id: a.id }, { note: "fixed" });
  check("update by id changes only the passed field", a.note === "fixed" && a.url === "https://bad/200" && a.client === "ACME");
  updateTicketTouch(s, { id: a.id }, { closedWithHelp: true });
  check("update can flip closedWithHelp", a.closedWithHelp === true);
  const miss = updateTicketTouch(s, { id: "nope" }, { note: "x" });
  check("update with unknown id returns a specific error", miss.error?.includes("nope"), miss.error);
  const missT = updateTicketTouch(s, { ticketId: "999" }, { note: "x" });
  check("update with unknown ticketId returns a specific error", missT.error?.includes("999"), missT.error);
  const none = updateTicketTouch(s, {}, { note: "x" });
  check("update with no target returns an error", !!none.error, none.error);
}

// --- update follows through to the linked quest ---
{
  const s = freshState();
  appendTicketTouch(s, { ticketId: "300", client: "ACME", url: "https://bad/300", note: "n", questId: "q1" });
  check("touch with questId attaches to quest", s.quests[0].haloTickets?.[0]?.url === "https://bad/300");
  updateTicketTouch(s, { ticketId: "300" }, { url: "https://good/300", client: "ACME-INC" });
  const ref = s.quests[0].haloTickets[0];
  check("url/client correction refreshes the quest's reference", ref.url === "https://good/300" && ref.client === "ACME-INC");
  check("quest reference isn't duplicated", s.quests[0].haloTickets.length === 1);
  check("state still validates", validateState(s) === null, validateState(s));
}

// --- delete ---
{
  const s = freshState();
  const a = appendTicketTouch(s, { ticketId: "400", client: "ACME", url: "u", note: "keep" });
  const b = appendTicketTouch(s, { ticketId: "400", client: "ACME", url: "u", note: "dupe", questId: "q1" });
  const res = deleteTicketTouch(s, { ticketId: "400" });
  check("delete by ticketId removes the newest", res.record?.id === b.id && s.ticketTouches.length === 1 && s.ticketTouches[0].id === a.id);
  check("delete leaves the quest's ticket reference alone", s.quests[0].haloTickets?.length === 1);
  deleteTicketTouch(s, { id: a.id });
  check("delete by id", s.ticketTouches.length === 0);
  const miss = deleteTicketTouch(s, { id: a.id });
  check("deleting an already-deleted id returns an error", !!miss.error, miss.error);
}

// --- attach / detach ---
{
  const s = freshState();
  attachHaloTicket(s, "q1", { ticketId: "500", client: "ACME", url: "https://bad/500" });
  attachHaloTicket(s, "q1", { ticketId: "500", client: "ACME", url: "https://good/500" });
  check("re-attach updates url in place (was a no-op before #134)", s.quests[0].haloTickets.length === 1 && s.quests[0].haloTickets[0].url === "https://good/500");
  attachHaloTicket(s, "q1", { ticketId: "501", client: "ACME", url: "u" });
  check("detach returns true when removed", detachHaloTicket(s, "q1", "500") === true && s.quests[0].haloTickets.length === 1);
  check("detach returns false when not attached", detachHaloTicket(s, "q1", "500") === false);
  detachHaloTicket(s, "q1", "501");
  check("detaching the last ticket drops the empty array", s.quests[0].haloTickets === undefined);
  check("state still validates after detach", validateState(s) === null, validateState(s));
}

let passed = 0;
for (const r of results) {
  if (r.ok) passed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.desc}${!r.ok && r.detail ? `  (${r.detail})` : ""}`);
}
console.log(`\n${passed}/${results.length} passed${passed === results.length ? "" : ` -- ${results.length - passed} FAILED`}`);
