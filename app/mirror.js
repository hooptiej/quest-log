// Server-side assembly of the read-only claude.ai Artifact mirror (#85,
// superseding #81/#83/#84's separate patches). This is the single source of
// truth for the mirror's HTML: it reads the live app/template.html for CSS
// (no hand-copied duplicate to drift, closing #83) and implements the
// render logic as real functions in this file (not a string blob spliced
// into questhelper.js, closing the drift risk #84 was about) against
// state.js's own readState() output. get_mirror_html() in questhelper.js
// just calls buildMirrorHtml() and returns the result -- no assembly logic
// lives client-side anymore.
import { readFile } from "node:fs/promises";

const TEMPLATE_PATH = new URL("./template.html", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// Pulls the live <style>...</style> block straight out of template.html at
// call time. Includes the terminal/wow theme blocks too (harmless here --
// the mirror only ever renders the default MU/TH/UR look since it never
// sets data-theme), but the point is there is nothing to hand-sync anymore.
export async function getMirrorCss() {
  const html = await readFile(TEMPLATE_PATH, "utf8");
  const start = html.indexOf("<style>");
  const end = html.indexOf("</style>", start);
  if (start === -1 || end === -1) throw new Error("template.html has no <style> block to extract");
  return html.slice(start + "<style>".length, end);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

// Node has no DOMParser, so notes get a small regex-based sanitizer instead
// of the client mirror's DOM-walk version -- same narrow allowlist (<a
// href/target>, <code>), same behavior: anything else is unwrapped to its
// text content, hrefs are validated to http(s)/mailto/relative, and every
// <a> gets rel="noopener noreferrer" forced on regardless of input.
const TAG_RE = /<(\/?)(a|code)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>/gi;
const ATTR_RE = /([a-z-]+)(?:="([^"]*)")?/gi;

function sanitizeNotes(html) {
  const input = String(html == null ? "" : html);
  let out = "";
  let last = 0;
  let openTag = null; // { name, href } while inside an <a>...</a> we're keeping
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(input))) {
    out += escapeHtml(input.slice(last, m.index));
    last = TAG_RE.lastIndex;
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (!closing) {
      if (tag === "code") {
        out += "<code>";
        openTag = { name: "code" };
      } else if (tag === "a") {
        let href = null;
        let target = null;
        ATTR_RE.lastIndex = 0;
        let am;
        while ((am = ATTR_RE.exec(m[3]))) {
          const name = am[1].toLowerCase();
          const value = am[2] ?? "";
          if (name === "href") href = value.trim();
          if (name === "target") target = value;
        }
        if (href && !/^(https?:|mailto:|\/)/.test(href)) href = null;
        out += "<a" + (href ? ` href="${escapeHtml(href)}"` : "") + (target ? ` target="${escapeHtml(target)}"` : "") + ' rel="noopener noreferrer">';
        openTag = { name: "a" };
      }
      // any other tag: dropped, its content still flows through as escaped text
    } else if (openTag && openTag.name === tag) {
      out += `</${tag}>`;
      openTag = null;
    }
  }
  out += escapeHtml(input.slice(last));
  return out;
}

function notesPlainText(html) {
  return String(html == null ? "" : html)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function notesTeaser(notes) {
  return escapeHtml(truncate(notesPlainText(notes), 120));
}

function blockedClass(q) {
  if (q.blocked) return " is-blocked";
  if (q.blockedByDescendant) return " is-blocked-inherited";
  return "";
}

function blockedBadge(q) {
  if (q.blocked) return '<span class="blocked-badge">&#9888; BLOCKED</span>';
  if (q.blockedByDescendant) return '<span class="blocked-badge blocked-badge-inherited">&#9888; blocked below</span>';
  return "";
}

function attentionBadge(q) {
  return q.attention ? '<span class="attention-badge">🔔 ATTENTION</span>' : "";
}

const STATUS_META = { progress: { tag: "ACTIVE" }, idea: { tag: "IDEA" }, done: { tag: "DONE" } };

function getDescendants(questId, allQuests) {
  const children = allQuests.filter((q) => q.parentId === questId);
  let result = children.slice();
  for (const c of children) result = result.concat(getDescendants(c.id, allQuests));
  return result;
}

function questProgress(q, allQuests) {
  const descendants = getDescendants(q.id, allQuests);
  const total = descendants.length + 1;
  const doneCount = (q.status === "done" ? 1 : 0) + descendants.filter((d) => d.status === "done").length;
  return { done: doneCount, total, pct: total ? Math.round((doneCount / total) * 100) : 0 };
}

function questRow(q) {
  const checked = q.status === "done";
  return (
    `<div class="quest${checked ? " is-done" : ""}${blockedClass(q)}" data-id="${escapeHtml(q.id)}">` +
    `<button type="button" class="quest-check" aria-pressed="${checked}" disabled aria-label="${escapeHtml(q.title)}">${checked ? "[x]" : "[ ]"}</button>` +
    `<div class="quest-title-row"><span class="quest-title">${escapeHtml(q.title)}</span>${blockedBadge(q)}${attentionBadge(q)}</div>` +
    (q.notes
      ? `<div class="quest-notes-teaser">${notesTeaser(q.notes)}</div><div class="quest-notes">${sanitizeNotes(q.notes)}${q.date ? ` <span style="opacity:0.6">(${escapeHtml(q.date)})</span>` : ""}</div>`
      : '<div class="quest-notes"></div>') +
    "</div>"
  );
}

function isTreeItem(q, parentIds) {
  return q.level === "quest" || !!q.parentId || parentIds.has(q.id);
}

function childCountLabel(q, children) {
  const noun = q.level === "quest" ? "mission" : "task";
  const doneCount = children.filter((c) => c.status === "done").length;
  return `${children.length} ${noun}${children.length === 1 ? "" : "s"}${doneCount > 0 ? `, ${doneCount} done` : ""}`;
}

function treeNode(q, byParent, allQuests) {
  const allChildren = byParent[q.id] || [];
  const activeChildren = allChildren.filter((c) => c.status !== "done");
  const doneChildren = allChildren.filter((c) => c.status === "done");
  const checked = q.status === "done";
  const meta = STATUS_META[q.status] || { tag: "UNKNOWN" };
  const progress = q.level === "quest" ? questProgress(q, allQuests) : null;

  let childrenHtml = activeChildren.map((c) => treeNode(c, byParent, allQuests)).join("");
  if (doneChildren.length) {
    childrenHtml +=
      `<div class="tree-completed collapsed">` +
      `<span class="completed-label">Completed (${doneChildren.length})</span>` +
      `<div class="tree-completed-items collapsed">${doneChildren.map((c) => treeNode(c, byParent, allQuests)).join("")}</div>` +
      "</div>";
  }
  const hasChildren = allChildren.length > 0;

  return (
    `<div class="tree-node${checked ? " is-done" : ""}${blockedClass(q)}" data-id="${escapeHtml(q.id)}">` +
    `<div class="tree-row"><span class="tree-title-group">` +
    (hasChildren
      ? `<span class="child-count">(${escapeHtml(childCountLabel(q, allChildren))})</span>`
      : '<span class="tree-toggle-spacer"></span>') +
    `<span class="tree-title">${escapeHtml(q.title)}</span>${blockedBadge(q)}</span>` +
    `<span class="tree-actions"><span class="tree-meta">${escapeHtml(q.level)}</span>` +
    (hasChildren && q.readyToClose ? '<span class="ready-badge">Ready to close</span>' : `<span class="quest-tag">${meta.tag}</span>`) +
    `${attentionBadge(q)}</span></div>` +
    (progress
      ? `<div class="quest-progress"><span class="progress-label">${progress.done}/${progress.total}</span><div class="bar-track"><div class="bar-fill" style="width:${progress.pct}%"></div></div></div>`
      : "") +
    (q.notes
      ? `<div class="tree-notes-teaser">${notesTeaser(q.notes)}</div><div class="tree-notes">${sanitizeNotes(q.notes)}${q.date ? ` <span style="opacity:0.6">(${escapeHtml(q.date)})</span>` : ""}</div>`
      : "") +
    (hasChildren ? `<div class="tree-children">${childrenHtml}</div>` : "") +
    "</div>"
  );
}

function renderQuestTree(state, parentIds) {
  const byParent = {};
  state.quests.forEach((q) => {
    if (!q.parentId) return;
    (byParent[q.parentId] = byParent[q.parentId] || []).push(q);
  });
  const roots = state.quests.filter((q) => !q.parentId && (q.level === "quest" || parentIds.has(q.id)));
  return roots.length ? roots.map((q) => treeNode(q, byParent, state.quests)).join("") : '<div class="empty-row">// no Quests yet</div>';
}

function computeMostNeglected(state) {
  const topLevel = state.quests.filter((q) => q.level === "quest" && !q.parentId);
  if (!topLevel.length) return null;
  const sorted = [...topLevel].sort((a, b) => {
    const aTime = a.lastTouchedAt ? new Date(a.lastTouchedAt).getTime() : 0;
    const bTime = b.lastTouchedAt ? new Date(b.lastTouchedAt).getTime() : 0;
    return aTime - bTime;
  });
  return sorted[0];
}

export async function buildMirrorHtml(state) {
  const css = await getMirrorCss();
  const parentIds = new Set();
  state.quests.forEach((q) => { if (q.parentId) parentIds.add(q.parentId); });

  const groups = { progress: [], idea: [], done: [] };
  state.quests.forEach((q) => {
    if (isTreeItem(q, parentIds)) return;
    if (!groups[q.status]) return;
    groups[q.status].push(q);
  });

  const questTree = renderQuestTree(state, parentIds);
  const idea = groups.idea.length ? groups.idea.map(questRow).join("") : '<div class="empty-row">// none</div>';
  const questRootCount = state.quests.filter((q) => !q.parentId && (q.level === "quest" || parentIds.has(q.id))).length;

  const flatLog = [];
  state.log.forEach((day) => {
    for (let i = day.entries.length - 1; i >= 0; i--) flatLog.push({ date: day.date, text: day.entries[i] });
  });
  const recentLog = flatLog.slice(0, 6);
  const logItems = recentLog
    .map((r) => `      <li><span class="log-mini-date">${escapeHtml(r.date)}</span>${escapeHtml(truncate(r.text, 200))}</li>`)
    .join("\n");

  const neglected = computeMostNeglected(state);
  const neglectedLine = neglected
    ? `<div class="boot-line"><span>LEAST-TOUCHED QUEST:</span><span>${escapeHtml(neglected.title)}${neglected.lastTouchedAt ? ` (${escapeHtml(String(neglected.lastTouchedAt).slice(0, 10))})` : " (never touched)"}</span></div>`
    : "";

  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

  return `<title>Questlog Mirror</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;700&family=Share+Tech+Mono&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
${css}
  /* mirror-only addition, not part of the live site's CSS */
  .mirror-banner {
    font-family: var(--font-mono); font-size: 0.78rem; letter-spacing: 0.05em;
    color: var(--accent2); background: color-mix(in srgb, var(--accent2) 10%, var(--surface));
    border: 1px solid color-mix(in srgb, var(--accent2) 45%, var(--border));
    border-radius: 4px; padding: 0.55rem 0.85rem; margin-bottom: 1rem; text-align: center;
  }
  .mirror-banner code { color: var(--accent); }
  .attention-badge {
    font-family: var(--font-mono); font-size: 0.76rem; letter-spacing: 0.06em;
    padding: 0.1rem 0.45rem; border-radius: 3px; border: 1px solid var(--accent2);
    color: var(--accent2); background: color-mix(in srgb, var(--accent2) 14%, transparent);
    text-transform: uppercase; white-space: nowrap;
  }
</style>

<div class="boot">
  <div class="boot-line"><span>WEYTANI-YULAND CORP // HOMELAB DIVISION</span><span class="ok">LINK ESTABLISHED</span></div>
  <div class="boot-line"><span>TERMINAL: <span>MU/TH/UR-6000</span></span><span class="ok">${state.quests.length} MISSIONS TRACKED</span></div>
  ${neglectedLine}
</div>
<div class="wrap">
  <div class="mirror-banner">READ-ONLY MIRROR &mdash; SNAPSHOT AS OF ${escapeHtml(stamp)}, NOT LIVE &mdash; edit at <code>questlog.local</code></div>

  <header class="masthead">
    <div class="eyebrow">Interest: None</div>
    <h1>MU/TH/UR Mission Log</h1>
    <p class="subtitle">Priority One — Track All Missions</p>
  </header>

  <div class="layout">
    <div class="layout-main">
      <section class="panel panel-quests">
        <div class="corner-bl"></div><div class="corner-br"></div>
        <h2>Quests <span class="count">${questRootCount}</span></h2>
        ${questTree}
      </section>

      <section class="panel panel-idea">
        <div class="corner-bl"></div><div class="corner-br"></div>
        <h2>Idea Board <span class="count">${groups.idea.length}</span></h2>
        ${idea}
      </section>
    </div>

    <aside class="layout-sidebar">
      <section class="panel log-panel-mini">
        <div class="corner-bl"></div><div class="corner-br"></div>
        <h2>Recent Activity</h2>
        <ul class="log-mini-list">
${logItems}
        </ul>
      </section>
    </aside>
  </div>
</div>

<footer class="sig">// end transmission — homelab ops · <a href="https://github.com/hooptiej/quest-log" target="_blank" rel="noopener">github.com/hooptiej/quest-log</a></footer>
`;
}
