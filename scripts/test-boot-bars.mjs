// Every live theme owns its boot bar (#140): a theme must not quietly fall back to the
// generic .boot strip (it did, on Test Pattern, for months). And the version and build stamp
// are in that bar on every theme (#175): in the served HTML, so there with JS off, and styled
// by the theme. Reads app/template.html and app/public/app.js directly, no server needed;
// the page is rendered with renderIndexHtml and a fake stamp, as GET / does.
//   node scripts/test-boot-bars.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderIndexHtml } from "../app/render.js";
import { formatBuildLine } from "../app/build-stamp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const template = readFileSync(join(ROOT, "app", "template.html"), "utf8");
const appJs = readFileSync(join(ROOT, "app", "public", "app.js"), "utf8");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

// The live themes: what the Display Mode dropdown offers. THEME_FLAVOR must list the same
// keys, so a theme added to only one of them is caught here too.
const select = template.match(/<select id="theme-select"[\s\S]*?<\/select>/);
check("found the Display Mode dropdown", !!select, "no <select id=\"theme-select\"> in app/template.html");
const offered = select ? [...select[0].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]) : [];
const flavorBlock = appJs.match(/var THEME_FLAVOR = \{([\s\S]*?)\n  \};/);
const flavored = flavorBlock ? [...flavorBlock[1].matchAll(/^    (\w+): \{/gm)].map((m) => m[1]) : [];
check("dropdown and THEME_FLAVOR list the same themes",
  offered.length > 0 && [...offered].sort().join() === [...flavored].sort().join(),
  `dropdown: ${offered.join(",")}  THEME_FLAVOR: ${flavored.join(",")}`);

// Every CSS rule as { selectors: [...], body }, comments stripped. Nested @media rules come
// out as ordinary rules, which is all this needs.
const css = template.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1].split(",").map((s) => s.trim().replace(/\s+/g, " ")),
  body: m[2],
}));
const rulesFor = (selector) => rules.filter((r) => r.selectors.includes(selector));

// The default theme (no data-theme attribute) is the one the base .boot rules ARE.
check("base .boot rule exists (MU/TH/UR, the default theme)", rulesFor(".boot").length > 0, "no .boot rule");
check("the hidden least-touched row really hides", rulesFor(".boot-line[hidden]").some((r) => /display:\s*none/.test(r.body)),
  "no .boot-line[hidden] { display: none } rule");

for (const theme of offered.filter((t) => t !== "muthur")) {
  const bootRules = rulesFor(`[data-theme="${theme}"] .boot`);
  const lineRules = rulesFor(`[data-theme="${theme}"] .boot-line`);
  const hidden = bootRules.some((r) => /display:\s*none/.test(r.body));
  // A rule for this theme's .boot, and that rule has to restyle the bar (a background), or
  // hide it and put the content somewhere in the theme (Raccoon Manor's clipboard strip). A
  // shared "radius for everything" rule that merely lists .boot does not pass the second check.
  check(`${theme}: has its own [data-theme] .boot rule`, bootRules.length > 0, `no rule with the selector [data-theme="${theme}"] .boot`);
  check(`${theme}: that rule restyles or relocates the bar`,
    hidden || bootRules.some((r) => /background/.test(r.body)),
    "its .boot rule neither sets a background nor hides the bar");
  if (!hidden) {
    check(`${theme}: styles its .boot-line rows`, lineRules.length > 0, `no rule with the selector [data-theme="${theme}"] .boot-line`);
  }
}

// The bar keeps showing everything the generic strip does, for every theme.
for (const id of ["boot-org-line", "terminal-name", "boot-time", "neglected-quest-line", "neglected-quest-value"]) {
  check(`markup still carries #${id}`, template.includes(`id="${id}"`), `no id="${id}" in app/template.html`);
}

// The build chip (#175). Render the page the way GET / does, with a fake stamp, and look at the
// HTML itself (no JS has run): the chip text must be inside the boot bar markup, inside the
// clipboard strip (Raccoon Manor hides the bar), and the version in the footer badge.
const FAKE_VERSION = "9.8.7";
const FAKE_LINE = formatBuildLine({ source: "image", build: "abc1234", built_at: "2026-11-07" });
const FAKE_CHIP = `v${FAKE_VERSION} · ${FAKE_LINE}`;
const served = renderIndexHtml(template, { quests: [] }, "tok", FAKE_VERSION, "prod", FAKE_LINE);
const bootBar = served.match(/<div class="boot">[\s\S]*?<\/div>\s*<div class="wrap">/);
const strip = served.match(/<div class="rm-clipboard-strip">[\s\S]*?<\/div>/);
const badge = served.match(/<span id="version-badge">([^<]*)<\/span>/);
check("served page has the boot bar markup", !!bootBar, "no <div class=\"boot\"> ... <div class=\"wrap\"> in the rendered page");
check("the boot bar carries the build chip, server-side", !!bootBar && bootBar[0].includes(`>${FAKE_CHIP}</span>`),
  `no "${FAKE_CHIP}" inside the boot bar in the served HTML`);
check("the clipboard strip (Raccoon Manor) carries the build chip, server-side", !!strip && strip[0].includes(`>${FAKE_CHIP}</span>`),
  `no "${FAKE_CHIP}" inside .rm-clipboard-strip in the served HTML`);
check("#version-badge is filled without JS", !!badge && badge[1] === `v${FAKE_VERSION}`,
  `#version-badge reads "${badge ? badge[1] : "(missing)"}", expected "v${FAKE_VERSION}"`);
check("no build placeholder is left in the served page", !/__BOOT_BUILD_TEXT__|__APP_VERSION_TEXT__|__BUILD_LINE_TEXT__/.test(served),
  "an unreplaced __..._TEXT__ placeholder is still in the HTML");
// A plain checkout and a missing stamp still read as something, never blank.
const plain = renderIndexHtml(template, { quests: [] }, "tok", FAKE_VERSION, "prod", formatBuildLine({ source: "checkout", build: "abc1234", built_at: null }));
check("a plain checkout shows the sha with 'source' in the boot bar", plain.includes(`>v${FAKE_VERSION} · build source abc1234</span>`),
  "no 'v9.8.7 · build source abc1234' in the served HTML");
const unstamped = renderIndexHtml(template, { quests: [] }, "tok", FAKE_VERSION, "prod");
check("rendering without a build line still shows a chip", unstamped.includes(`>v${FAKE_VERSION} · build source unknown</span>`),
  "no 'v9.8.7 · build source unknown' in the served HTML");
const hostile = renderIndexHtml(template, { quests: [] }, "tok", FAKE_VERSION, "prod", "<img src=x onerror=alert(1)> $&");
check("the build text is HTML-escaped in the chip", !hostile.includes("<img src=x onerror") && hostile.includes("&lt;img src=x onerror=alert(1)&gt; $&amp;"),
  "an unescaped or pattern-mangled build line reached the page");

// And every live theme styles the chip in its own voice: the default (MU/TH/UR) through the
// base .boot-build rule, each other theme through its own [data-theme] rule, Raccoon Manor on
// the clipboard tag.
check("base .boot-build rule exists (MU/TH/UR, the default theme)", rulesFor(".boot-build").length > 0, "no .boot-build rule");
for (const theme of offered.filter((t) => t !== "muthur")) {
  const selector = theme === "raccoonmanor" ? `[data-theme="${theme}"] .rm-build-tag` : `[data-theme="${theme}"] .boot-build`;
  check(`${theme}: styles its build chip`, rulesFor(selector).length > 0, `no rule with the selector ${selector}`);
}
// Hadley's footer was invisible: its fixed scene layers (z-index 1) paint over a static footer.
check("hadleyshope: the footer is lifted above the fixed scene layers",
  rulesFor('[data-theme="hadleyshope"] footer.sig').some((r) => /position:\s*relative/.test(r.body) && /z-index:\s*([2-9]|\d\d)/.test(r.body)),
  "no [data-theme=\"hadleyshope\"] footer.sig rule with position: relative and z-index >= 2");

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
