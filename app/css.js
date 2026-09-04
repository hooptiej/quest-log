// Extracted CSS from template.html for use by get_mirror_template() MCP tool.
// This is the authoritative CSS stylesheet for the quest log UI.
// SYNCED 2026-09-04 from app/template.html's current <style> block (see #81 --
// this had drifted stale since before today, missing #72/#74/#77/#78's
// changes entirely; #81 tracks the real structural fix so this stops being
// a manual step to remember).
export const QUEST_LOG_CSS = `
  :root {
    --bg: #1c1c1c;
    --surface: #262626;
    --surface-2: #2f2f2f;
    --border: #3a3a3a;
    --text: #e8e8e8;
    --muted: #a8a8a8;
    --accent: #7CFC00;
    --accent-dim: #4f8a00;
    --accent2: #b57edc;
    --alarm: #ff5c3d;
    --idea: #7a8290;

    --font-display: 'Orbitron', -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    --font-head: 'Orbitron', -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    --font-mono: 'Share Tech Mono', 'IBM Plex Mono', ui-monospace, Consolas, monospace;
    --font-body: 'IBM Plex Sans', -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;

    --body-bg-image:
      radial-gradient(ellipse at top, color-mix(in srgb, var(--accent) 5%, transparent), transparent 55%),
      repeating-linear-gradient(0deg, rgba(255,255,255,0.012) 0px, rgba(255,255,255,0.012) 1px, transparent 1px, transparent 3px),
      url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='matrix' values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.05 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>"),
      radial-gradient(ellipse 90% 70% at 50% 40%, transparent 55%, rgba(0,0,0,0.35) 100%);
  }

  /* ---------- theme: Field Terminal (#9) ---------- */
  [data-theme="terminal"] {
    --bg: #080c09;
    --surface: #10160f;
    --surface-2: #17201a;
    --border: #23372a;
    --text: #bdf6c9;
    --muted: #6d9678;
    --accent: #58e07a;
    --accent-dim: #2f6b45;
    --accent2: #ffb703;
    --alarm: #ff6b57;
    --idea: #7fb08a;

    --font-display: 'VT323', 'Courier New', monospace;
    --font-head: 'IBM Plex Mono', ui-monospace, Consolas, monospace;
    --font-mono: 'IBM Plex Mono', 'Share Tech Mono', ui-monospace, Consolas, monospace;
    --font-body: 'IBM Plex Mono', ui-monospace, Consolas, monospace;

    --body-bg-image:
      repeating-linear-gradient(0deg, color-mix(in srgb, var(--text) 2.5%, transparent) 0px, color-mix(in srgb, var(--text) 2.5%, transparent) 1px, transparent 1px, transparent 3px);
  }
  [data-theme="terminal"] h1 { letter-spacing: 0.01em; }

  /* ---------- theme: Guild Charter / WoW (#9) ---------- */
  [data-theme="wow"] {
    --bg: #241407;
    --surface: #3a2413;
    --surface-2: #4a2f18;
    --border: #8a6423;
    --text: #f1dfb6;
    --muted: #b99b6b;
    --accent: #ffd100;
    --accent-dim: #a3790f;
    --accent2: #a6231f;
    --alarm: #ff4d2e;
    --idea: #4fa8d8;

    /* Same display face as MU/TH/UR (that Cinzel Q) -- carried over on purpose. */
    --font-display: 'Cinzel', Georgia, 'Times New Roman', serif;
    --font-head: 'MedievalSharp', 'Cinzel', Georgia, serif;
    --font-mono: 'MedievalSharp', 'Share Tech Mono', ui-monospace, Consolas, monospace;
    --font-body: 'IM Fell English', Georgia, 'Times New Roman', serif;

    --body-bg-image:
      radial-gradient(ellipse at top, color-mix(in srgb, var(--accent) 8%, transparent), transparent 55%),
      url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='p'><feTurbulence type='fractalNoise' baseFrequency='0.045' numOctaves='4' seed='7' stitchTiles='stitch'/><feColorMatrix type='matrix' values='0.4 0 0 0 0.15  0.28 0 0 0 0.08  0.08 0 0 0 0  0 0 0 0.4 0'/></filter><rect width='100%25' height='100%25' filter='url(%23p)'/></svg>"),
      radial-gradient(ellipse 90% 70% at 50% 40%, transparent 45%, rgba(0,0,0,0.45) 100%);
  }
  [data-theme="wow"] h1 {
    letter-spacing: 0.02em;
    background: linear-gradient(180deg, #fff3c4, var(--accent) 55%, var(--accent-dim));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    filter: drop-shadow(0 1px 0 rgba(0,0,0,0.6));
  }
  [data-theme="wow"] .boot,
  [data-theme="wow"] .status-panel,
  [data-theme="wow"] .panel {
    border-width: 2px;
    border-image: linear-gradient(135deg, var(--accent-dim), var(--accent) 45%, var(--accent-dim)) 1;
    box-shadow: inset 0 0 0 1px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06), 0 3px 14px rgba(0,0,0,0.55);
  }
  [data-theme="wow"] .panel::before,
  [data-theme="wow"] .panel::after,
  [data-theme="wow"] .panel .corner-bl,
  [data-theme="wow"] .panel .corner-br {
    background: radial-gradient(circle at 35% 30%, #fff3c4, transparent 55%), var(--panel-accent, var(--accent));
    box-shadow: 0 0 4px color-mix(in srgb, var(--accent) 70%, transparent), 0 1px 1px rgba(0,0,0,0.6);
  }
  [data-theme="wow"] .add-btn { color: #241407; }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--bg);
    background-image: var(--body-bg-image);
    background-attachment: fixed;
    color: var(--text);
    font-family: var(--font-body);
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    position: relative;
  }

  /* CRT scanlines, MU/TH/UR only -- previously judged "too much" and left
     out, brought back by request. A fixed full-viewport overlay rather
     than a body background layer so the lines stay a constant thickness
     regardless of page height/scroll, sitting above content (z-index) but
     never intercepting clicks (pointer-events: none). Repeating gradient
     is cheap to render at any viewport size, unlike a tiled image. Scoped
     to the absence of [data-theme] since muthur is the unmarked default. */
  :root:not([data-theme]) body::after {
    content: "";
    position: fixed;
    inset: 0;
    z-index: 9999;
    pointer-events: none;
    background-image: repeating-linear-gradient(
      0deg,
      rgba(0, 0, 0, 0.18) 0px,
      rgba(0, 0, 0, 0.18) 1px,
      transparent 1px,
      transparent 3px
    );
    mix-blend-mode: multiply;
  }

  .wrap { max-width: 47.5rem; margin: 0 auto; padding: 1.25rem 1.25rem 2rem; }

  /* ---------- main + sidebar layout ---------- */

  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1rem;
    align-items: start;
  }

  @media (min-width: 900px) {
    .wrap { max-width: 65rem; }
    .layout { grid-template-columns: minmax(0, 1fr) 280px; }
    .layout-sidebar { position: sticky; top: 1.5rem; }
  }

  /* ---------- header / terminal boot ---------- */

  .boot {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--border);
    background: var(--surface);
    padding: 0.5rem 1.1rem;
    margin-bottom: 0.1rem;
  }

  .boot-line {
    font-family: var(--font-mono);
    font-size: 0.85rem;
    color: var(--accent-dim);
    letter-spacing: 0.06em;
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }
  .boot-line + .boot-line { margin-top: 0.15rem; }
  .boot-line .ok { color: var(--accent); }
  .boot-line .env-badge {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    letter-spacing: 0.06em;
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
    background: color-mix(in srgb, var(--alarm) 20%, transparent);
    border: 1px solid var(--alarm);
    color: var(--alarm);
    text-transform: uppercase;
    font-weight: 600;
  }

  .theme-select {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.8rem;
    letter-spacing: 0.05em;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
  }
  .theme-select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .name-input { width: 6.5rem; }
  .name-input::placeholder { color: var(--muted); opacity: 0.6; }

  .scale-stepper {
    display: flex; align-items: center; gap: 0.35rem;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 3px;
    padding: 0.05rem 0.3rem;
  }
  .scale-stepper button {
    background: none; border: none; color: var(--accent); font-family: var(--font-mono);
    font-size: 0.85rem; line-height: 1; padding: 0.1rem 0.25rem; cursor: pointer;
  }
  .scale-stepper button:hover { color: var(--text); }
  .scale-stepper button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  #scale-value {
    font-family: var(--font-mono); font-size: 0.8rem; letter-spacing: 0.05em;
    color: var(--accent); min-width: 2.6rem; text-align: center;
  }

  header.masthead {
    position: relative;
    text-align: center;
    padding: 0 0 0.1rem;
  }

  .theme-switcher {
    position: absolute;
    top: 0.5rem;
    right: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.35rem;
  }
  .switcher-row { display: flex; align-items: center; gap: 0.5rem; }
  .theme-switcher label {
    font-family: var(--font-mono);
    font-size: 0.76rem;
    letter-spacing: 0.06em;
    color: var(--muted);
    text-transform: uppercase;
  }

  .eyebrow {
    font-family: var(--font-head);
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.32em;
    color: var(--muted);
    text-transform: uppercase;
  }

  h1 {
    font-family: var(--font-display);
    font-size: clamp(2.1rem, 6vw, 3rem);
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--text);
    margin: 0.05rem 0 0.1rem;
    text-shadow: 0 0 22px color-mix(in srgb, var(--accent) 25%, transparent);
    text-wrap: balance;
  }

  .subtitle {
    font-family: var(--font-head);
    font-size: 0.95rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    color: var(--accent);
    text-transform: uppercase;
    margin: 0;
  }

  /* ---------- status readout ---------- */

  .status-panel {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    padding: 0.65rem 1rem;
    margin-bottom: 0.85rem;
  }

  .status-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    font-family: var(--font-mono);
  }

  .status-label {
    font-size: 0.85rem;
    letter-spacing: 0.14em;
    color: var(--muted);
    text-transform: uppercase;
  }

  .status-value {
    font-size: 1.15rem;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }

  .bar-track {
    margin-top: 0.4rem;
    height: 9px;
    border-radius: 5px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent-dim), var(--accent));
    box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 50%, transparent);
    transition: width 0.5s ease;
  }

  /* Per-quest progress bars (#29): each top-level Quest shows completion
     status for its own subtree (Missions/Tasks within that Quest only) */
  .quest-progress {
    margin-top: 0.3rem;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .progress-label {
    color: var(--muted);
    opacity: 0.8;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .quest-progress .bar-track {
    flex: 1;
    margin-top: 0;
    height: 6px;
    min-width: 50px;
  }
  .quest-progress .bar-fill {
    box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 40%, transparent);
  }

  /* ---------- panels ---------- */

  .panel {
    position: relative;
    border: 1px solid var(--border);
    border-radius: 3px;
    background:
      linear-gradient(155deg, rgba(255,255,255,0.025), transparent 40%),
      var(--surface);
    padding: 0.95rem 1.15rem 1rem;
    margin-bottom: 1rem;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.03), 0 2px 10px rgba(0,0,0,0.35);
  }

  /* worn rivets at the corners, like a bolted bulkhead panel */
  .panel::before, .panel::after,
  .panel .corner-br, .panel .corner-bl {
    content: "";
    position: absolute;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background:
      radial-gradient(circle at 35% 30%, rgba(255,255,255,0.35), transparent 55%),
      var(--panel-accent, var(--accent));
    opacity: 0.55;
    box-shadow: 0 1px 1px rgba(0,0,0,0.6);
  }
  .panel::before { top: 8px; left: 8px; }
  .panel::after { top: 8px; right: 8px; }
  .panel .corner-bl { bottom: 8px; left: 8px; }
  .panel .corner-br { bottom: 8px; right: 8px; }

  .panel-idea { --panel-accent: var(--idea); }
  .panel-quests { --panel-accent: var(--accent2); }

  /* ---------- blocked flag flair (#26) ----------
     Was a whole panel treatment (hazard-striped background) when "blocked"
     was a status with its own section; now it's a per-item accent since
     blocked is an independent flag any quest/mission/task can carry. Own
     blocked gets the full hazard stripe + solid accent bar; inherited
     (blockedByDescendant, flowing uphill from a blocked child) gets a
     thinner, unstriped bar so the two read as different severities. */
  .quest.is-blocked, .tree-node.is-blocked {
    border-left: 3px solid var(--alarm);
    background-image: repeating-linear-gradient(135deg, var(--alarm) 0 8px, transparent 8px 16px);
    background-size: 100% 4px;
    background-position: top left;
    background-repeat: repeat-x;
    background-origin: border-box;
  }
  .quest.is-blocked-inherited, .tree-node.is-blocked-inherited {
    border-left: 3px solid color-mix(in srgb, var(--alarm) 55%, transparent);
  }
  .blocked-badge {
    font-family: var(--font-mono);
    font-size: 0.76rem;
    letter-spacing: 0.06em;
    padding: 0.1rem 0.45rem;
    border-radius: 3px;
    border: 1px solid var(--alarm);
    color: var(--alarm);
    background: color-mix(in srgb, var(--alarm) 14%, transparent);
    text-transform: uppercase;
    white-space: nowrap;
  }
  .blocked-badge-inherited {
    color: color-mix(in srgb, var(--alarm) 75%, var(--muted));
    border-color: color-mix(in srgb, var(--alarm) 55%, transparent);
    background: color-mix(in srgb, var(--alarm) 7%, transparent);
  }
  .blocked-btn:hover { border-color: var(--alarm); color: var(--alarm); }

  /* ---------- quest tree (Quest -> Mission -> Task) ---------- */

  .tree-node {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    margin-top: 0.45rem;
    background: var(--surface-2);
  }
  .tree-node:first-child { margin-top: 0; }
  .tree-node .tree-children { margin-top: 0.45rem; padding-left: 1rem; border-left: 1px dashed var(--border); }

  .tree-row { display: flex; align-items: baseline; justify-content: space-between; gap: 0.6rem; flex-wrap: wrap; }
  .tree-title-group { display: flex; align-items: baseline; gap: 0.4rem; }
  .tree-toggle {
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    color: var(--panel-accent, var(--accent));
    font-family: var(--font-mono);
    font-size: 0.88rem;
    line-height: 1.3;
    cursor: pointer;
    flex-shrink: 0;
  }
  .tree-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .tree-toggle-spacer { display: inline-block; width: 0.7rem; flex-shrink: 0; }
  .tree-children.collapsed { display: none; }

  /* Child-count badge (#37): shown next to .tree-toggle only while its
     children are collapsed, so a rolled-up node still says what's inside
     ("4 missions", "3 tasks, 2 done") instead of giving no hint at all. */
  .child-count {
    font-family: var(--font-mono);
    font-size: 0.8rem;
    color: var(--muted);
    opacity: 0.75;
  }
  .child-count.collapsed { display: none; }
  .tree-title { font-weight: 600; font-size: 0.94rem; color: var(--text); }
  .tree-node.is-done .tree-title { color: var(--muted); text-decoration: line-through; text-decoration-color: var(--accent2); text-decoration-thickness: 1.5px; }
  .tree-meta { font-family: var(--font-mono); font-size: 0.78rem; letter-spacing: 0.05em; color: var(--muted); text-transform: uppercase; }
  .tree-notes { color: var(--muted); font-size: 0.92rem; margin-top: 0.3rem; }
  .tree-notes a { color: var(--accent2); }
  .tree-notes.collapsed, .quest-notes.collapsed { display: none; }

  /* Teaser/synopsis (#37): a short plain-text preview shown only while the
     full notes are collapsed, so collapsing something doesn't just leave a
     blank gap where the notes used to be. */
  .tree-notes-teaser {
    color: var(--muted);
    font-size: 0.9rem;
    font-style: italic;
    opacity: 0.75;
    margin-top: 0.3rem;
  }
  .quest-notes-teaser {
    grid-column: 2;
    grid-row: 2;
    color: var(--muted);
    font-size: 0.9rem;
    font-style: italic;
    opacity: 0.75;
    margin-top: 0.15rem;
  }
  .tree-notes-teaser.collapsed, .quest-notes-teaser.collapsed { display: none; }

  /* Notes-disclosure rollup (#30): a separate toggle from .tree-toggle --
     this one only ever hides/shows the notes text next to it, never the
     structural children, so the two controls can't step on each other.
     Rendered inline at the end of the teaser/notes text (#37) rather than
     as a bare triangle in the crowded title row, styled like a visible
     text link so it doesn't get lost in a long writeup. */
  .notes-toggle {
    background: none;
    border: none;
    padding: 0;
    margin-left: 0.3em;
    color: var(--panel-accent, var(--accent));
    font-family: var(--font-mono);
    font-size: 0.88rem;
    font-weight: 600;
    line-height: 1.3;
    cursor: pointer;
    white-space: nowrap;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .notes-toggle:hover { filter: brightness(1.2); }
  .notes-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .tree-notes code { font-family: var(--font-mono); font-size: 0.85em; color: var(--text); background: var(--surface); padding: 0.05em 0.35em; border-radius: 3px; }

  .tree-actions { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
  .ready-badge {
    font-family: var(--font-mono);
    font-size: 0.74rem;
    letter-spacing: 0.06em;
    padding: 0.1rem 0.45rem;
    border-radius: 3px;
    border: 1px solid var(--accent2);
    color: var(--accent2);
    text-transform: uppercase;
    white-space: nowrap;
  }

  .panel h2 {
    font-family: var(--font-head);
    font-size: 0.92rem;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    margin: 0 0 0.6rem;
    color: var(--panel-accent, var(--accent));
    display: flex;
    align-items: center;
    gap: 0.55rem;
  }

  .panel h2 .count {
    font-family: var(--font-mono);
    font-size: 0.82rem;
    color: var(--muted);
    font-weight: 400;
    letter-spacing: 0;
  }

  .empty-row {
    font-family: var(--font-mono);
    font-size: 0.9rem;
    color: var(--muted);
    padding: 0.4rem 0;
    opacity: 0.7;
  }

  /* ---------- quest rows ---------- */

  .quest {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.15rem 0.85rem;
    align-items: start;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
  }
  .quest.is-blocked, .quest.is-blocked-inherited { padding-left: 0.6rem; }
  .quest:last-child { border-bottom: none; }

  .quest-check {
    grid-column: 1;
    grid-row: 1 / 3;
    align-self: start;
    justify-self: start;
    margin-top: 0.15rem;
    width: 1.5rem;
    height: 1.5rem;
    border: none;
    background: none;
    padding: 0;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 1.1rem;
    color: var(--panel-accent, var(--accent));
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 3px;
    transition: transform 0.15s ease, background 0.15s ease;
  }
  .quest-check:hover { background: rgba(124,252,0,0.08); }
  .quest-check:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .quest-check.just-toggled { animation: check-pulse 0.4s ease; }
  @keyframes check-pulse { 0% { transform: scale(1); } 40% { transform: scale(1.35); } 100% { transform: scale(1); } }

  .quest-title-row {
    grid-column: 2;
    grid-row: 1;
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .quest-title {
    font-weight: 600;
    font-size: 0.98rem;
    color: var(--text);
  }
  .quest.is-done .quest-title { color: var(--muted); text-decoration: line-through; text-decoration-color: var(--accent2); text-decoration-thickness: 1.5px; }

  .quest-tag {
    font-family: var(--font-mono);
    font-size: 0.76rem;
    letter-spacing: 0.08em;
    padding: 0.1rem 0.45rem;
    border-radius: 3px;
    border: 1px solid currentColor;
    color: var(--panel-accent, var(--accent));
    background: color-mix(in srgb, var(--panel-accent, var(--accent)) 12%, transparent);
    text-transform: uppercase;
    white-space: nowrap;
  }

  .quest-notes {
    grid-column: 2;
    grid-row: 2;
    color: var(--muted);
    font-size: 0.94rem;
    margin-top: 0.15rem;
  }
  .quest-notes a { color: var(--accent2); }
  .quest-notes code { font-family: var(--font-mono); font-size: 0.85em; color: var(--text); background: var(--surface-2); padding: 0.05em 0.35em; border-radius: 3px; }

  .note-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.76rem;
    letter-spacing: 0.05em;
    padding: 0.15rem 0.4rem;
    border-radius: 3px;
    cursor: pointer;
    white-space: nowrap;
  }
  .note-btn:hover { border-color: var(--panel-accent, var(--accent)); color: var(--panel-accent, var(--accent)); }
  .note-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* ---------- add quest ---------- */

  .add-panel { --panel-accent: #7CFC00; }
  .add-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    font-family: var(--font-mono);
    font-size: 0.9rem;
  }
  .add-prompt { color: var(--accent); flex-shrink: 0; }
  .add-input {
    flex: 1;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.9rem;
    padding: 0.55rem 0.7rem;
    min-width: 0;
  }
  .add-input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
  .add-input::placeholder { color: var(--muted); opacity: 0.6; }
  .add-btn {
    font-family: var(--font-head);
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    background: var(--accent);
    color: #0d1400;
    border: none;
    border-radius: 3px;
    padding: 0.6rem 0.9rem;
    cursor: pointer;
    flex-shrink: 0;
  }
  .add-btn:hover { filter: brightness(1.1); }
  .add-btn:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }

  .save-indicator {
    font-family: var(--font-mono);
    font-size: 0.76rem;
    color: var(--muted);
    letter-spacing: 0.08em;
    text-align: right;
    margin: -1.4rem 0 1.2rem;
    opacity: 0;
    transition: opacity 0.3s ease;
  }
  .save-indicator.visible { opacity: 0.75; }
  .save-indicator.error { color: var(--alarm); opacity: 1; }

  .cursor-blink {
    display: inline-block;
    width: 0.5em;
    height: 1em;
    background: var(--accent);
    margin-left: 2px;
    animation: blink 1.1s steps(1) infinite;
    vertical-align: text-bottom;
  }
  @keyframes blink { 50% { opacity: 0; } }

  /* ---------- session log (compact sidebar widget) ---------- */

  .log-panel-mini { --panel-accent: #a8a8a8; padding: 1.1rem 1.2rem 1.2rem; }
  .log-panel-mini h2 { font-size: 0.82rem; margin-bottom: 0.75rem; }
  .log-mini-list { margin: 0; padding: 0; list-style: none; }
  .log-mini-list li {
    font-family: var(--font-mono);
    font-size: 0.8rem;
    color: var(--muted);
    padding: 0.25rem 0;
    line-height: 1.4;
    border-bottom: 1px dashed var(--border);
  }
  .log-mini-list li:last-child { border-bottom: none; }
  .log-mini-date {
    display: block;
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    color: var(--accent);
    opacity: 0.8;
    margin-bottom: 0.1rem;
  }

  /* Unroll (#30): the mini widget is deliberately truncated to 6 recent
     entries -- this brings back the old always-on full-history view as an
     on-demand expansion instead, so nothing's actually lost. */
  .unroll-btn {
    display: block;
    width: 100%;
    margin-top: 0.75rem;
    background: none;
    border: 1px dashed var(--border);
    border-radius: 3px;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.76rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 0.35rem;
    cursor: pointer;
  }
  .unroll-btn:hover { border-color: var(--panel-accent, var(--accent)); color: var(--panel-accent, var(--accent)); }
  .unroll-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .log-full.collapsed { display: none; }
  .log-full-date {
    font-family: var(--font-mono);
    font-size: 0.76rem;
    letter-spacing: 0.08em;
    color: var(--accent);
    opacity: 0.85;
    margin: 0.9rem 0 0.35rem;
  }
  .log-full-date:first-child { margin-top: 0.85rem; }
  .log-full-list { margin: 0 0 0.2rem; padding-left: 1.1rem; }
  .log-full-list li {
    font-size: 0.86rem;
    color: var(--muted);
    line-height: 1.5;
    margin-bottom: 0.3rem;
  }

  footer.sig {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--border);
    background: var(--surface);
    padding: 0.5rem 1.1rem;
    margin-top: 1.25rem;
    text-align: center;
    font-family: var(--font-mono);
    font-size: 0.8rem;
    color: var(--muted);
    opacity: 0.55;
    letter-spacing: 0.08em;
  }

  @media (prefers-reduced-motion: reduce) {
    .cursor-blink { animation: none; opacity: 1; }
    .quest-check.just-toggled { animation: none; }
    .bar-fill { transition: none; }
  }

  @media (max-width: 560px) {
    .theme-switcher { position: static; align-items: center; margin-bottom: 0.75rem; }
  }
`;
