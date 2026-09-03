#!/usr/bin/env node
// Adversarial self-test for XSS prevention in quest note rendering (#57).
//
// Verifies that user notes containing dangerous HTML/script sequences
// (</script>, <!--, placeholder-like strings) are safely escaped at render
// time and don't break the inline script block or allow code injection.
//
// Usage: node scripts/test-adversarial-notes.mjs
// Exit code 0 if all tests pass, 1 if any fail.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderIndexHtml } from "../app/render.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..");
const TEMPLATE_PATH = join(ROOT_DIR, "app", "template.html");

// Test adversarial note content
const adversarialNotes = [
  '</script><script>alert(1)</script>',
  '<!--',
  '<!-- malicious comment',
  '__STATE_JSON__',
  '__WRITE_TOKEN_VALUE__',
  '__APP_VERSION_VALUE__',
  '__QUEST_LOG_ENV_VALUE__',
  '<img src=x onerror=alert(1)>',
  'before</script>after',
  '*/\nalert("pwned");\n/*',
];

// Placeholder state object
function makeTestState(noteContents) {
  return {
    quests: noteContents.map((notes, i) => ({
      id: `test-quest-${i}`,
      title: `Test Quest ${i}`,
      status: "progress",
      notes: notes,
      level: "mission",
    })),
    log: [],
    _version: 1,
  };
}

// Extract inline script content from rendered HTML
function extractScriptContent(html) {
  const match = html.match(/<script>\s*(window\.__QUEST_STATE__.*?)\s*<\/script>/s);
  if (!match) throw new Error("Could not find inline script block in rendered HTML");
  return match[1];
}

// Verify that a string is valid JavaScript by parsing it with new Function()
function isValidJavaScript(code) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
    return true;
  } catch (err) {
    console.error(`  JavaScript parse error: ${err.message}`);
    return false;
  }
}

// Round-trip test: verify that escaped content round-trips back to original
function verifyRoundTrip(html, originalNotes) {
  const scriptContent = extractScriptContent(html);
  const stateMatch = scriptContent.match(/window\.__QUEST_STATE__\s*=\s*(\{.*?\});/s);
  if (!stateMatch) throw new Error("Could not extract state JSON from script");

  const stateJson = stateMatch[1];
  let state;
  try {
    state = JSON.parse(stateJson);
  } catch (err) {
    throw new Error(`State JSON parse failed: ${err.message}`);
  }

  for (let i = 0; i < originalNotes.length; i++) {
    const original = originalNotes[i];
    const roundTripped = state.quests[i]?.notes;
    if (roundTripped !== original) {
      console.error(
        `  Round-trip mismatch for quest ${i}:\n    Original: ${JSON.stringify(original)}\n    Got: ${JSON.stringify(roundTripped)}`
      );
      return false;
    }
  }
  return true;
}

// Simulate the render function WITHOUT escaping (the buggy version)
function renderIndexHtmlBuggy(template, state, writeToken, appVersion, questLogEnv) {
  return template
    .replace("__WRITE_TOKEN_VALUE__", JSON.stringify(writeToken))
    .replace("__APP_VERSION_VALUE__", JSON.stringify(appVersion))
    .replace("__QUEST_LOG_ENV_VALUE__", JSON.stringify(questLogEnv))
    .replace("__STATE_JSON__", JSON.stringify(state)); // No escaping!
}

async function runTests() {
  console.log("Loading template...");
  const template = await readFile(TEMPLATE_PATH, "utf8");

  console.log("\n=== Proof: test FAILS without the fix ===");
  console.log("Testing WITHOUT escaping (buggy version)...");
  const testState = makeTestState(adversarialNotes);
  const renderedBuggy = renderIndexHtmlBuggy(template, testState, "test-token", "1.0.00", "test");

  console.log("  Attempting to verify inline script as valid JavaScript...");
  try {
    const scriptContentBuggy = extractScriptContent(renderedBuggy);
    if (!isValidJavaScript(scriptContentBuggy)) {
      console.log("  ✓ As expected, script is INVALID without escaping (test correctly catches the bug)");
    } else {
      console.error("  ✗ Unexpected: script somehow parsed, but shouldn't without escaping");
      return false;
    }
  } catch (err) {
    console.log(`  ✓ As expected, extraction/parse failed: ${err.message}`);
  }

  console.log("\n=== Proof: test PASSES with the fix ===");
  console.log("Testing WITH escaping (fixed version)...");
  const rendered = renderIndexHtml(template, testState, "test-token", "1.0.00", "test");

  console.log("  Verifying inline script is valid JavaScript...");
  const scriptContent = extractScriptContent(rendered);
  if (!isValidJavaScript(scriptContent)) {
    console.error("FAIL: Rendered script is not valid JavaScript");
    return false;
  }
  console.log("  ✓ Script is valid JavaScript");

  console.log("  Verifying content round-trips correctly...");
  if (!verifyRoundTrip(rendered, adversarialNotes)) {
    console.error("FAIL: Content round-trip test failed");
    return false;
  }
  console.log("  ✓ Content round-trips correctly");

  console.log("\nAll adversarial tests passed!");
  return true;
}

runTests()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((err) => {
    console.error(`FAIL: ${err.message}`);
    process.exit(1);
  });
