# Theme System Specification

The quest-log theme system provides a pluggable CSS and JavaScript framework for reskinning the entire UI. Themes control colors, fonts, decorative effects, and interactive behaviors.

## CSS Custom Properties Contract

Every theme must define this complete set of custom properties. These are the structural/semantic colors and fonts used by all UI components.

| Property | Purpose |
|----------|---------|
| `--bg` | Page background color |
| `--surface` | Primary surface/panel background (slightly lighter than `--bg`) |
| `--surface-2` | Secondary surface (slightly lighter than `--surface`, used for inputs, hover states) |
| `--border` | Border and divider color |
| `--text` | Primary text color |
| `--muted` | Secondary text color (labels, hints, metadata) |
| `--accent` | Primary accent color (highlights, active states, focus rings) |
| `--accent-dim` | Darker variant of accent (for depth/shadows) |
| `--accent2` | Secondary accent color (used sparingly for contrast) |
| `--alarm` | Alert/warning/blocked color (red family) |
| `--idea` | Status indicator color (used for "idea" status) |
| `--font-display` | Display face (headings, logos, large text) |
| `--font-head` | Heading face (section headers, subheadings) |
| `--font-mono` | Monospace face (code, metadata, system text) |
| `--font-body` | Body face (default text, paragraphs) |
| `--body-bg-image` | Background image/gradient overlay (set to `none` for plain backgrounds) |

## JavaScript THEME_FLAVOR Object

Each theme must have an entry in `app/public/app.js`'s `THEME_FLAVOR` object with exactly these fields:

```javascript
THEME_FLAVOR.mytheme = {
  orgLine: "ORGANIZATION // DIVISION",           // Masthead organizational unit
  terminalName: "TERMINAL NAME",                 // Masthead terminal identifier
  titlePrefix: "Prefix",                         // Prefix for page <title>
  titleSuffix: "Suffix",                         // Suffix for page <title>
  subtitlePrefix: "Prefix text",                 // Subtitle lead-in (before quest count)
  subtitleSuffix: "Suffix text",                 // Subtitle trailing text
  logLabel: "Label Text",                        // Label for activity log sidebar
  designation: function (name) {                 // Format user's designation/role
    return name ? "TITLE " + name.toUpperCase() : "default";
  }
}
```

**Field details:**
- `orgLine`: Appears in the masthead boot status bar (org name / division).
- `terminalName`: Appears in boot bar, usually a fictional system name.
- `titlePrefix`/`titleSuffix`: Page `<title>` is built as `` `${titlePrefix} | ${titleSuffix}` ``.
- `subtitlePrefix`/`subtitleSuffix`: Subtitle HTML becomes `` `<prefix> <quest-count> <suffix>` ``.
- `logLabel`: Heading text for the "Recent Activity" sidebar panel.
- `designation`: A function that takes the user's name and returns their formatted title/role (displayed in masthead and UI badges).

## Theme Dropdown Entry

Add a single `<option>` entry to the theme `<select>` at line ~2459 of `app/template.html`:

```html
<option value="mytheme">DISPLAY NAME HERE</option>
```

The `value` must match the theme key in `THEME_FLAVOR` and the CSS `[data-theme="..."]` selector prefix. The display name is user-facing and can be whatever fits the theme's framing.

## Optional: Generic Hook Classes

These CSS classes are provided as optional styling hooks. A theme can add style rules for any or all of them; omitting them means components use their base style (plain/neutral). None are required.

| Class | Component | Purpose |
|-------|-----------|---------|
| `.log-panel-mini` | Recent Activity / Recent Tickets sidebars | Lets a theme add decorative frames, backgrounds, or custom heading colors to sidebar panels |
| `.status-panel` | Masthead system-status readout | Lets a theme add borders, backgrounds, or special styling to the boot/status bar |
| `.card-edge`, `.card-edge-top`, `.card-edge-bottom` | Quest/mission/task cards | Decorative stripes, tabs, or borders at card edges |
| `.corner-bl`, `.corner-br` | Panel decoration corners | Corner ornaments on panels (via pseudo-elements `::before` and `::after`) |
| `.tree-completed` | Completed quests section | Styling for the nested completed-items container (e.g., left border color) |

Example: raccoonmanor adds parchment textures and card-edge hiding; hadleyshope adds striped corner rivets; testpattern adds color-bar edges. Muthur/terminal define none, and render plain.

## Per-Theme JavaScript Effects

If a theme needs interactive behavior or ambient animations (lightning, particle effects, periodic polling), define an `initXxxEffects()` function:

1. **Location**: Add the function in `app/public/app.js`, near the other theme effects (around line 113–410).
2. **Guard**: Check `document.documentElement.dataset.theme === "themename"` to ensure the function only runs when the theme is active. Use a static `initialized` flag to avoid re-running on theme switches.
3. **Idempotency**: The function is called once at page load (line ~1401). If a user switches themes and back, ensure state/listeners are safe (no duplicated event handlers).
4. **Call site**: Add `initXxxEffects();` to the list of theme-init calls at the bottom of the file (line ~1401–1403).

Example guard pattern (from hadleyshope):
```javascript
var hhInitialized = false;
function isHadleysHope() { return document.documentElement.dataset.theme === "hadleyshope"; }
function initHadleysHopeEffects() {
  if (hhInitialized) return;
  hhInitialized = true;
  // ... wiring and setup ...
}
```

**When to use effects:** Only if the theme needs periodic animations (loops), polling timers, event listeners, or DOM updates that can't be expressed in pure CSS. Decorative CSS (gradients, shadows, fonts) belongs in the `[data-theme="..."]` block, not in JS effects.

**Themes without effects:** Muthur, terminal, and computercatsimple intentionally have no effects functions. They are intentionally plain and do not need to opt into anything.

## Adding a New Theme

1. **CSS block** (in `app/template.html`):
   - Add a `[data-theme="mytheme"] { ... }` block after the last existing theme.
   - Define all 15 custom properties listed above (colors, fonts, `--body-bg-image`).
   - Optionally add rules for `.log-panel-mini`, `.status-panel`, `.card-edge-*`, `.corner-bl`/`.corner-br`, `.tree-completed`, and any other hook classes.
   - Any additional theme-specific custom properties (e.g., `--resin` in hadleyshope) are fine; just don't skip the base contract.

2. **THEME_FLAVOR entry** (in `app/public/app.js`):
   - Add an entry to the `THEME_FLAVOR` object with all 8 required fields.
   - Test the `designation` function with a sample name to confirm output.

3. **Theme dropdown option** (in `app/template.html` around line 2459):
   - Add `<option value="mytheme">DISPLAY NAME</option>` to the theme `<select>`.

4. **Effects function** (in `app/public/app.js`, only if needed):
   - If the theme needs animations or interactive behavior, define `initMythemeEffects()`.
   - Guard it with a theme check.
   - Call it from the bottom-of-file effects init block.

5. **Test**:
   - Reload the app.
   - Select the new theme from the Display Mode dropdown.
   - Verify colors, fonts, and layout are correct.
   - Verify any optional hook classes render as intended.
   - If effects were added, verify animations/interactions work and stop when switching away.

## Validation

- **CSS properties**: Use browser DevTools to inspect elements and confirm all custom properties are defined (no `unset`/undefined values).
- **THEME_FLAVOR fields**: Ensure all 8 fields are present; check that `designation(name)` returns a sensible string.
- **Dropdown label**: Verify the `<option>` value matches the CSS selector and THEME_FLAVOR key exactly.
- **Syntax**: Run `node --check app/public/app.js` before committing to catch JS syntax errors.
