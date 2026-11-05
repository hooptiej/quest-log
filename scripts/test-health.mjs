// The /health body (#143): besides status/version/hooksVersion it carries the
// auto-log and Pro Mode switches, so the hooks never need the full state.
//   node scripts/test-health.mjs
import { buildHealth, loadHealth } from "../app/health.js";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

const base = { version: "1.3.0", hooksVersion: "1.1.0" };
const show = (x) => JSON.stringify(x);

let h = buildHealth({ ...base, state: { quests: [], _autoLog: { enabled: true }, _proMode: true } });
check("flags on", h.autoLog === true && h.proMode === true, show(h));
check("keeps status/version/hooksVersion", h.status === "ok" && h.version === "1.3.0" && h.hooksVersion === "1.1.0", show(h));

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
check("unreadable state -> null flags, still ok", h.autoLog === null && h.proMode === null && h.status === "ok" && h.version === "1.3.0", show(h));

h = await loadHealth({ ...base, readState: async () => ({ _autoLog: { enabled: true }, _proMode: false }) });
check("loadHealth reads the state", h.autoLog === true && h.proMode === false, show(h));

// #156: the build stamp rides on /health as build (sha) and built_at (date).
h = buildHealth({ ...base, state: { quests: [] }, build: "a1b2c3d", builtAt: "2026-11-05" });
check("health carries build and built_at", h.build === "a1b2c3d" && h.built_at === "2026-11-05", show(h));

h = buildHealth({ ...base, state: { quests: [] } });
check("no stamp passed -> build unknown, built_at null, still ok", h.build === "unknown" && h.built_at === null && h.status === "ok", show(h));

h = await loadHealth({ ...base, build: "e5f6a7b", builtAt: null, readState: async () => { throw new Error("ENOENT"); } });
check("loadHealth passes the stamp even when state is unreadable", h.build === "e5f6a7b" && h.built_at === null && h.autoLog === null, show(h));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
