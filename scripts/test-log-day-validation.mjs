#!/usr/bin/env node
// Self-test for mission-log day validation (#132).
//
// A single log day without an `entries` array used to pass POST /api/state
// (validateState only checked that `log` was an array) and then crash
// render() for every visitor. This checks that validateState now rejects
// malformed days with a message naming the bad day, and still accepts every
// legitimate shape: bare-string entries (pre-#92) and {text, time} entries.
//
// Usage: node scripts/test-log-day-validation.mjs
// Prints PASS/FAIL per case and a summary line. Nothing is written anywhere.

import { validateState } from "../state.js";

const quest = { id: "q1", title: "Quest", status: "idea", level: "mission", parentId: null };
const withLog = (log) => ({ quests: [quest], log });

const cases = [
  // [description, log, expectValid, substring the error must contain]
  ["empty log", [], true],
  ["bare-string entries (pre-#92)", [{ date: "2026-09-01", entries: ["did a thing"] }], true],
  ["{text, time} entries (#92)", [{ date: "2026-09-02", entries: [{ text: "did a thing", time: "2026-09-02T10:00:00.000Z" }] }], true],
  ["{text} entry with no time", [{ date: "2026-09-02", entries: [{ text: "did a thing" }] }], true],
  ["mixed entry shapes in one day", [{ date: "2026-09-03", entries: ["old", { text: "new", time: "2026-09-03T10:00:00.000Z" }] }], true],
  ["day with no entries array at all", [{ date: "2026-09-21" }], false, "2026-09-21"],
  ["the real 2026-09-22 shape: singular `entry`", [{ date: "2026-09-21", entry: "CHC migration note" }], false, "2026-09-21"],
  ["entries is a string, not an array", [{ date: "2026-09-21", entries: "oops" }], false, "2026-09-21"],
  ["missing date", [{ entries: ["x"] }], false, "date"],
  ["date not YYYY-MM-DD", [{ date: "Sept 21", entries: ["x"] }], false, "Sept 21"],
  ["entry is a number", [{ date: "2026-09-21", entries: [42] }], false, "2026-09-21"],
  ["entry object without text", [{ date: "2026-09-21", entries: [{ time: "2026-09-21T10:00:00.000Z" }] }], false, "2026-09-21"],
  ["entry time is not a string", [{ date: "2026-09-21", entries: [{ text: "x", time: 12345 }] }], false, "2026-09-21"],
  ["log day is null", [null], false, "log"],
];

let passed = 0;
const failures = [];
for (const [desc, log, expectValid, mustMention] of cases) {
  const err = validateState(withLog(log));
  let ok, why;
  if (expectValid) {
    ok = err === null;
    why = ok ? "accepted" : `expected accept, got rejected: ${err}`;
  } else if (err === null) {
    ok = false;
    why = "expected reject, but it was accepted";
  } else {
    ok = err.includes(mustMention);
    why = ok ? `rejected: ${err}` : `rejected, but the message doesn't name "${mustMention}": ${err}`;
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${desc} -- ${why}`);
  if (ok) passed++;
  else failures.push(desc);
}

console.log("");
console.log(failures.length
  ? `RESULT: ${failures.length} of ${cases.length} FAILED: ${failures.join("; ")}`
  : `RESULT: all ${cases.length} passed`);
