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
export function renderIndexHtml(template, state, writeToken, appVersion, questLogEnv) {
  return template
    .replace("__WRITE_TOKEN_VALUE__", JSON.stringify(writeToken))
    .replace("__APP_VERSION_VALUE__", JSON.stringify(appVersion))
    .replace("__QUEST_LOG_ENV_VALUE__", JSON.stringify(questLogEnv))
    .replace("__STATE_JSON__", JSON.stringify(state).replace(/</g, '\\u003c'));
}
