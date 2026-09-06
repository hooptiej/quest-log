#!/usr/bin/env node
// UserPromptSubmit hook: reminds an active Claude Code session to log a new
// ask into quest-log (via add_idea) before scoping or implementing it,
// instead of only being recoverable from conversation scrollback.
//
// Hooked to a real per-message event rather than a timer/poll on purpose --
// this project has already seen a "wait and check periodically" approach be
// unreliable in a way an event-triggered reminder isn't.
//
// Gated on a flag stored in quest-log's own shared state (see
// getAutoLog/setAutoLog in state.js, toggled via the set_auto_log MCP tool)
// rather than a local file, so flipping it from any one of your machines
// takes effect for this hook everywhere it's checked out -- no per-machine
// setup beyond having the repo. Fails silent on any network hiccup (offline,
// off-LAN, quest-log down) so a missed reminder never breaks a session.

const QUEST_LOG_URL = process.env.QUEST_LOG_URL || "http://questlog.local/api/state";
const TIMEOUT_MS = 1500;

async function main() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let state;
  try {
    const res = await fetch(QUEST_LOG_URL, { signal: controller.signal });
    if (!res.ok) return;
    state = await res.json();
  } catch {
    return;
  } finally {
    clearTimeout(timer);
  }

  if (!state?._autoLog?.enabled) return;

  process.stdout.write(
    "If the message just submitted is a new concrete ask (a bug, a feature, a multi-part " +
    "request), log it into quest-log via add_idea now, with enough detail in the notes to " +
    "stand alone -- before scoping or starting the implementation. Skip this reminder if the " +
    "message isn't a new ask (a question, an answer to something already asked, small talk, " +
    "a reply mid-task, etc.)."
  );
}

main();
