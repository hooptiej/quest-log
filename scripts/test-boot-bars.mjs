// Every live theme owns its boot bar (#140): a theme must not quietly fall back to the
// generic .boot strip (it did, on Test Pattern, for months). Reads app/template.html and
// app/public/app.js directly, no server needed.
//   node scripts/test-boot-bars.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
