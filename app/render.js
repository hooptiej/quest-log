// Pure HTML-rendering logic, split out of server.js so it can be imported
// (e.g. by scripts/test-adversarial-notes.mjs) without pulling in server.js's
// module-level side effects -- an unconditional process.exit(1) if the data
// file is missing, and an unconditional app.listen() that binds a real port.
// This file has zero side effects on import: just one pure function.

// Render the index HTML by splicing state and config into the template.
// __STATE_JSON__ carries arbitrary user-authored text (quest notes) and
// must be substituted LAST. Any placeholder-looking substring a note
// happens to contain (e.g. a bug report literally describing
// "__APP_VERSION_VALUE__") would otherwise be sitting in the HTML by the
// time an earlier .replace() call goes looking for that exact text --
// and .replace() matches the FIRST occurrence in the whole string, user
// content included. Resolving every fixed system placeholder first means
// there's nothing left for stray note text to accidentally satisfy.
//
// The final .replace(/</g, '\\u003c') on the state JSON escapes all <
// characters, preventing user notes containing "</script>" or "<!--" from
// breaking out of the inline script block (#56).
// buildLine is the footer's build stamp text (#156, see formatBuildLine in
// app/build-stamp.js). It is HTML-escaped here and spliced into the footer
// text, never into the script block, so it is spliced before the state JSON.
export function renderIndexHtml(template, state, writeToken, appVersion, questLogEnv, buildLine = "build source unknown") {
  return template
    .replace("__PAGE_TITLE_VALUE__", questLogEnv === "dev" ? "DEV-Questlog" : "Questlog")
    .replace("__BUILD_LINE_TEXT__", escapeHtml(buildLine))
    .replace("__WRITE_TOKEN_VALUE__", JSON.stringify(writeToken))
    .replace("__APP_VERSION_VALUE__", JSON.stringify(appVersion))
    .replace("__QUEST_LOG_ENV_VALUE__", JSON.stringify(questLogEnv))
    .replace("__STATE_JSON__", JSON.stringify(state).replace(/</g, '\\u003c'));
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
