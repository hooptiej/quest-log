// The build stamp (#156): the baked file the Docker image writes, the git
// fallback for a plain checkout, the "unknown" floor when neither exists, and
// the footer line. Nothing here may throw.
//   node scripts/test-build-stamp.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readBakedStamp, gitShortSha, resolveBuildStamp, formatBuildLine, STAMP_FILE } from "../app/build-stamp.js";
import { renderIndexHtml } from "../app/render.js";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
const show = (x) => JSON.stringify(x);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function tempRoot(name) {
  return mkdtempSync(join(tmpdir(), `ql-bs-${name}-`));
}

// 1. The baked file the Docker image writes.
let dir = tempRoot("baked");
writeFileSync(join(dir, STAMP_FILE), '{"build":"a1b2c3d","built_at":"2026-11-05"}\n');
let s = readBakedStamp(dir);
check("baked file -> image stamp", s?.source === "image" && s.build === "a1b2c3d" && s.built_at === "2026-11-05", show(s));
check("baked file wins over git (resolveBuildStamp)", resolveBuildStamp(dir).source === "image", show(resolveBuildStamp(dir)));

// 2. Baked file with empty args (no --build-arg given): build is "", so not a stamp.
dir = tempRoot("empty-args");
writeFileSync(join(dir, STAMP_FILE), '{"build":"","built_at":""}\n');
check("empty build arg -> no baked stamp", readBakedStamp(dir) === null, show(readBakedStamp(dir)));

// 3. Bad or hostile contents never throw, and never reach the page.
dir = tempRoot("bad");
writeFileSync(join(dir, STAMP_FILE), "{not json");
check("malformed JSON -> null, no throw", readBakedStamp(dir) === null);
writeFileSync(join(dir, STAMP_FILE), '{"build":"<script>x</script>","built_at":"2026-11-05"}');
check("non-hex build rejected", readBakedStamp(dir) === null, show(readBakedStamp(dir)));
writeFileSync(join(dir, STAMP_FILE), '{"build":"a1b2c3d","built_at":"yesterday"}');
s = readBakedStamp(dir);
check("bad built_at -> stamp kept, date null", s?.build === "a1b2c3d" && s.built_at === null, show(s));
writeFileSync(join(dir, STAMP_FILE), "null");
check("JSON null -> null, no throw", readBakedStamp(dir) === null);

// 4. No baked file, no git: unknown, never a crash.
dir = tempRoot("nothing");
s = resolveBuildStamp(dir);
check("no stamp file and no git repo -> safe placeholder or git sha, no throw", s.source === "unknown" ? s.build === "unknown" && s.built_at === null : s.source === "checkout", show(s));
check("gitShortSha returns null outside a repo (or a valid sha)", (() => {
  const sha = gitShortSha(dir);
  return sha === null || /^[0-9a-f]{4,40}$/.test(sha);
})());

// 5. A plain checkout (this repo, no baked file): source + git short sha.
check("repo root has no baked stamp file (checkout path is exercised)", !existsSync(join(ROOT, STAMP_FILE)), STAMP_FILE + " exists at repo root");
s = resolveBuildStamp(ROOT);
const sha = gitShortSha(ROOT);
if (sha) {
  check("plain checkout -> source checkout with the git short sha", s.source === "checkout" && s.build === sha && s.built_at === null, show(s));
} else {
  check("git unavailable here -> checkout falls back to unknown without crashing", s.source === "unknown" && s.build === "unknown", show(s));
}

// 6. The footer line.
check("image line", formatBuildLine({ source: "image", build: "a1b2c3d", built_at: "2026-11-05" }) === "build a1b2c3d (2026-11-05)");
check("image with no date line", formatBuildLine({ source: "image", build: "a1b2c3d", built_at: null }) === "build a1b2c3d (date unknown)");
check("checkout line", formatBuildLine({ source: "checkout", build: "a1b2c3d", built_at: null }) === "build source a1b2c3d");
check("unknown line", formatBuildLine({ source: "unknown", build: "unknown", built_at: null }) === "build source unknown");

// 7. The footer is spliced into the page as text, escaped, and the page still renders.
const template = readFileSync(join(ROOT, "app", "template.html"), "utf8");
const page = renderIndexHtml(template, { quests: [] }, "tok", "1.3.00", "prod", formatBuildLine({ source: "image", build: "a1b2c3d", built_at: "2026-11-05" }));
check("page footer carries the build line", page.includes('<span id="build-stamp">build a1b2c3d (2026-11-05)</span>'));
check("no placeholder left in the page", !page.includes("__BUILD_LINE_TEXT__"));
const hostile = renderIndexHtml(template, { quests: [] }, "tok", "1.3.00", "prod", "<img src=x onerror=alert(1)>");
check("build line is HTML-escaped", hostile.includes("&lt;img src=x onerror=alert(1)&gt;") && !hostile.includes("<img src=x"));
const plain = renderIndexHtml(template, { quests: [] }, "tok", "1.3.00", "prod");
check("default build line when none is passed", plain.includes("build source unknown"));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
