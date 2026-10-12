// The GET /health body (#143). Besides status/version/hooksVersion it carries
// the auto-log and Pro Mode switches, so the plugin's hooks can read them
// from this small response (cached a minute per session) instead of
// downloading the whole state. Its own module (not inline in server.js) so it
// can be tested without starting the server; see scripts/test-health.mjs.
import { getAutoLog, getProMode } from "../state.js";

// /health must never fail because the state can't be read: the switches
// are null then, and everything else is still reported.
export function buildHealth({ version, hooksVersion, state }) {
  let autoLog = null;
  let proMode = null;
  if (state) {
    try {
      autoLog = !!getAutoLog(state).enabled;
      proMode = !!getProMode(state);
    } catch {
      autoLog = null;
      proMode = null;
    }
  }
  return { status: "ok", version, hooksVersion, autoLog, proMode };
}

export async function loadHealth({ version, hooksVersion, readState }) {
  let state = null;
  try {
    state = await readState();
  } catch {
    state = null;
  }
  return buildHealth({ version, hooksVersion, state });
}
