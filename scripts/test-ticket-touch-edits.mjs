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
  parseTouchDate,
  getTicketStats,
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

// --- backdating (#149) ---
// parseTouchDate takes an injectable `now`, so these cases are fixed points in
// time, not whatever day the suite happens to run on.
const NOW = new Date("2026-11-05T15:00:00Z");
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
{
  const day = parseTouchDate("2026-11-03", NOW);
  check("YYYY-MM-DD parses to that day's noon (local)", day.timestamp === new Date(2026, 10, 3, 12).toISOString(), JSON.stringify(day));
  check("YYYY-MM-DD lands on that calendar day in local and UTC", localDay(new Date(day.timestamp)) === "2026-11-03" && day.timestamp.slice(0, 10) === "2026-11-03", day.timestamp);
  const iso = parseTouchDate("2026-11-03T09:15:00-07:00", NOW);
  check("full ISO timestamp with offset parses exactly", iso.timestamp === "2026-11-03T16:15:00.000Z", JSON.stringify(iso));
  const zed = parseTouchDate("2026-11-03T09:15:00Z", NOW);
  check("full ISO timestamp with Z parses exactly", zed.timestamp === "2026-11-03T09:15:00.000Z", JSON.stringify(zed));
  const today = parseTouchDate("2026-11-05", NOW);
  check("today's date stamps the actual instant, never noon in the future", today.timestamp === NOW.toISOString(), JSON.stringify(today));
}
{
  const fut = parseTouchDate("2026-11-06", NOW);
  check("future YYYY-MM-DD rejected with a clear error", !!fut.error && fut.error.includes("in the future") && fut.timestamp === undefined, fut.error);
  const futIso = parseTouchDate("2026-11-05T16:00:00Z", NOW);
  check("future ISO timestamp rejected with a clear error", !!futIso.error && futIso.error.includes("in the future"), futIso.error);
  const unparse = parseTouchDate("yesterday", NOW);
  check("unparseable value rejected, not coerced to now", !!unparse.error && unparse.error.includes("yesterday") && unparse.timestamp === undefined, unparse.error);
  const sept = parseTouchDate("Sept 21", NOW);
  check("free-form date rejected", !!sept.error && sept.timestamp === undefined, sept.error);
  const empty = parseTouchDate("", NOW);
  check("empty date rejected, not treated as omitted", !!empty.error, empty.error);
  const feb30 = parseTouchDate("2026-02-30", NOW);
  check("impossible calendar day rejected (YYYY-MM-DD)", !!feb30.error && feb30.error.includes("real calendar day"), feb30.error);
  const feb30iso = parseTouchDate("2026-02-30T10:00:00Z", NOW);
  check("impossible calendar day rejected (ISO; Date.parse would roll it over)", !!feb30iso.error && feb30iso.error.includes("real calendar day"), feb30iso.error);
  const noTz = parseTouchDate("2026-11-03T09:15:00", NOW);
  check("ISO without a timezone rejected", !!noTz.error && noTz.error.includes("timezone"), noTz.error);
  const tooOld = parseTouchDate("2026-08-01", NOW);
  check("touch older than the 90-day window rejected (would be pruned on save)", !!tooOld.error && tooOld.error.includes("90-day"), tooOld.error);
}
{
  const s = freshState();
  const backdated = appendTicketTouch(s, { ticketId: "600", client: "ACME", url: "u", note: "day-only", timestamp: parseTouchDate("2026-10-30").timestamp });
  check("backdated touch stores the given timestamp", backdated.timestamp === parseTouchDate("2026-10-30").timestamp, backdated.timestamp);
  const stamped = appendTicketTouch(s, { ticketId: "601", client: "ACME", url: "u", note: "now" });
  check("no timestamp still stamps ~now", Math.abs(Date.parse(stamped.timestamp) - Date.now()) < 5000, stamped.timestamp);
}
{
  // The scoreboard counts "today" by timestamp, so work backdated to an earlier
  // day must not show up as today's touch. Uses the real clock (the stats
  // function has no injectable now).
  const s = freshState();
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const ts = parseTouchDate(localDay(threeDaysAgo)).timestamp;
  appendTicketTouch(s, { ticketId: "700", client: "ACME", url: "u", note: "backfill", timestamp: ts });
  const stats = getTicketStats(s);
  check("backdated touch is not counted as today on the scoreboard", stats.touched.today === 0, JSON.stringify(stats.touched));
  check("backdated touch within the week still counts for the week", stats.touched.week === 1, JSON.stringify(stats.touched));
}
{
  const s = freshState();
  const a = appendTicketTouch(s, { ticketId: "800", client: "ACME", url: "u", note: "n" });
  const fixed = parseTouchDate("2026-11-02T10:00:00-07:00", NOW).timestamp;
  const res = updateTicketTouch(s, { id: a.id }, { timestamp: fixed });
  check("update corrects the timestamp", res.record?.timestamp === fixed && a.timestamp === fixed, JSON.stringify(res));
  updateTicketTouch(s, { id: a.id }, { note: "still here" });
  check("update without timestamp leaves the timestamp alone", a.timestamp === fixed);
}

let passed = 0;
for (const r of results) {
  if (r.ok) passed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.desc}${!r.ok && r.detail ? `  (${r.detail})` : ""}`);
}
console.log(`\n${passed}/${results.length} passed${passed === results.length ? "" : ` -- ${results.length - passed} FAILED`}`);
