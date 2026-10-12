// The /health body (#143): besides status/version/hooksVersion it carries the
// auto-log and Pro Mode switches, so the hooks never need the full state.
//   node scripts/test-health.mjs
import { buildHealth, loadHealth } from "../app/health.js";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

const base = { version: "1.3.00", hooksVersion: "1.1.0" };
const show = (x) => JSON.stringify(x);

let h = buildHealth({ ...base, state: { quests: [], _autoLog: { enabled: true }, _proMode: true } });
check("flags on", h.autoLog === true && h.proMode === true, show(h));
check("keeps status/version/hooksVersion", h.status === "ok" && h.version === "1.3.00" && h.hooksVersion === "1.1.0", show(h));

h = buildHealth({ ...base, state: { quests: [] } });
check("flags default to false on a state that never set them", h.autoLog === false && h.proMode === false, show(h));

h = buildHealth({ ...base, state: { quests: [], _autoLog: { enabled: false }, _proMode: false } });
check("flags off", h.autoLog === false && h.proMode === false, show(h));

h = buildHealth({ ...base, state: null });
check("null state -> null flags", h.autoLog === null && h.proMode === null && h.status === "ok" && h.hooksVersion === "1.1.0", show(h));

const hostile = { get _autoLog() { throw new Error("boom"); } };
h = buildHealth({ ...base, state: hostile });
check("a state that throws -> null flags", h.autoLog === null && h.proMode === null && h.status === "ok", show(h));

h = await loadHealth({ ...base, readState: async () => { throw new Error("ENOENT"); } });
check("unreadable state -> null flags, still ok", h.autoLog === null && h.proMode === null && h.status === "ok" && h.version === "1.3.00", show(h));

h = await loadHealth({ ...base, readState: async () => ({ _autoLog: { enabled: true }, _proMode: false }) });
check("loadHealth reads the state", h.autoLog === true && h.proMode === false, show(h));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
