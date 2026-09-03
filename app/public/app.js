(function () {
  "use strict";

  var STATUS_META = {
    progress: { tag: "ACTIVE" },
    idea: { tag: "IDEA" },
    done: { tag: "DONE" }
  };
  // Mirrors state.js's LEVEL_UP -- what promote() steps a level up to.
  var LEVEL_UP = { task: "mission", mission: "quest" };

  // Per-theme flavor text (#21): muthur is just one theme now, so its Alien
  // wording shouldn't be hardcoded as the only wording. Each theme supplies
  // an org line, a subtitle lead-in, and a designation template -- the
  // designation is a function (not a fixed prefix string) since a future
  // WoW entry (#9) needs the name and title in the other order ("{name},
  // the Explorer" rather than "TITLE {name}").
  var THEME_FLAVOR = {
    muthur: {
      orgLine: "WEYTANI-YULAND CORP // HOMELAB DIVISION",
      terminalName: "MU/TH/UR-6000",
      titlePrefix: "MU/TH/UR",
      titleSuffix: "Mission Log",
      subtitlePrefix: "Priority One",
      designation: function (name) { return name ? "WARRANT OFFICER " + name.toUpperCase() : "Interest: None"; }
    },
    terminal: {
      orgLine: "UNDERVAULT OPERATIONS // WASTELAND DIVISION",
      terminalName: "ROBCO TERMLINK",
      titlePrefix: "ROBCO",
      titleSuffix: "Survey Report",
      subtitlePrefix: "Undervault Directive",
      designation: function (name) { return name ? "WASTELANDER " + name.toUpperCase() : "Unknown Wanderer"; }
    },
    wow: {
      orgLine: "ADVENTURERS' GUILD // QUEST BOARD DIVISION",
      terminalName: "GUILD QUEST BOARD",
      titlePrefix: "Azeroth",
      titleSuffix: "Quest Log",
      subtitlePrefix: "Bound By Oath",
      designation: function (name) { return name ? name.toUpperCase() + ", THE ADVENTURER" : "Unknown Adventurer"; }
    }
  };
  var NAME_KEY = "questlog-name";
  // Source of truth for the Designation once it's been saved server-side
  // (#33) -- read once at load from the server-rendered state rather than
  // localStorage, so the set_designation MCP tool actually takes effect on
  // reload instead of the old localStorage copy winning.
  var SERVER_DESIGNATION = ((window.__QUEST_STATE__ && window.__QUEST_STATE__.designation) || "").trim();

  function currentDesignationName() {
    if (SERVER_DESIGNATION) return SERVER_DESIGNATION;
    try { return (localStorage.getItem(NAME_KEY) || "").trim(); } catch (e) { return ""; }
  }

  function applyFlavor() {
    var theme = document.documentElement.dataset.theme || "muthur";
    var flavor = THEME_FLAVOR[theme] || THEME_FLAVOR.muthur;
    var name = currentDesignationName();
    var orgLineEl = document.getElementById("boot-org-line");
    if (orgLineEl) orgLineEl.textContent = flavor.orgLine;
    var terminalNameEl = document.getElementById("terminal-name");
    if (terminalNameEl) terminalNameEl.textContent = flavor.terminalName;
    var titlePrefixEl = document.getElementById("title-prefix");
    if (titlePrefixEl) titlePrefixEl.textContent = flavor.titlePrefix;
    var titleSuffixEl = document.getElementById("title-suffix");
    if (titleSuffixEl) titleSuffixEl.textContent = flavor.titleSuffix;
    var subtitleEl = document.getElementById("subtitle-prefix");
    if (subtitleEl) subtitleEl.textContent = flavor.subtitlePrefix;
    var eyebrowEl = document.getElementById("eyebrow");
    if (eyebrowEl) eyebrowEl.textContent = flavor.designation(name);
    var versionEl = document.getElementById("version-badge");
    if (versionEl && window.__APP_VERSION__) versionEl.textContent = "v" + window.__APP_VERSION__;
  }

  function truncate(s, max) {
    if (s.length <= max) return s;
    return s.slice(0, max).replace(/\s+\S*$/, "") + "…";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Notes are stored as trusted-author HTML (links/code) rather than plain
  // text, but render through here rather than raw innerHTML so nothing
  // outside that allowlist -- <script>, event-handler attrs, javascript:
  // hrefs -- ever executes, whatever produced the notes value.
  var NOTES_ALLOWED_ATTRS = { A: ["href", "target"] };
  function sanitizeNotes(html) {
    var doc = new DOMParser().parseFromString("<div>" + String(html == null ? "" : html) + "</div>", "text/html");
    var root = doc.body.firstChild;

    function clean(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        if (child.nodeType === 1) {
          var tag = child.tagName;
          if (tag !== "A" && tag !== "CODE") {
            node.replaceChild(document.createTextNode(child.textContent), child);
            return;
          }
          var keep = NOTES_ALLOWED_ATTRS[tag] || [];
          Array.prototype.slice.call(child.attributes).forEach(function (attr) {
            if (keep.indexOf(attr.name) === -1) child.removeAttribute(attr.name);
          });
          if (tag === "A") {
            var href = (child.getAttribute("href") || "").trim();
            if (!/^(https?:|mailto:|\/)/i.test(href)) child.removeAttribute("href");
            child.setAttribute("rel", "noopener noreferrer");
          }
          clean(child);
        } else if (child.nodeType !== 3) {
          node.removeChild(child);
        }
      });
    }

    clean(root);
    return root.innerHTML;
  }

  // Plain-text rendering of notes (tags stripped, not just allowlisted) --
  // only ever used to build the collapsed-state teaser below, never
  // inserted as HTML, so no sanitizing allowlist is needed here.
  function notesPlainText(html) {
    var doc = new DOMParser().parseFromString("<div>" + String(html == null ? "" : html) + "</div>", "text/html");
    return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
  }

  // A quest/mission can take a child note; a task (already a leaf) can't.
  function childLevelFor(level) {
    if (level === "quest") return "mission";
    if (level === "mission") return "task";
    return null;
  }

  // Recursively collects all descendants of a quest (children, grandchildren, etc.)
  function getDescendants(questId, allQuests) {
    var children = allQuests.filter(function (q) { return q.parentId === questId; });
    var result = children.slice();
    for (var i = 0; i < children.length; i++) {
      result = result.concat(getDescendants(children[i].id, allQuests));
    }
    return result;
  }

  // Computes done/total count for a quest's subtree (itself + all descendants)
  function questProgress(q, allQuests) {
    var descendants = getDescendants(q.id, allQuests);
    var total = descendants.length + 1; // +1 for the quest itself
    var doneCount = (q.status === "done" ? 1 : 0) + descendants.filter(function (d) { return d.status === "done"; }).length;
    return { done: doneCount, total: total, pct: total ? Math.round((doneCount / total) * 100) : 0 };
  }

  // Notes-disclosure rollup (#30): every item gets a toggle that hides just
  // its own notes text -- title, status tag/badge, and any children always
  // stay visible regardless of this toggle. Independent of the structural
  // children-toggle in treeNode (#21), which this never touches. Collapsed
  // by default regardless of status (#37): a long note clutters the log
  // whether the item is done or still active, so every item starts
  // collapsed with a teaser instead of only ones already marked done.
  //
  // Rendered as a labeled link under the teaser/notes text itself (not a
  // bare triangle buried in the title row among half a dozen other
  // controls) -- a first pass put it up there and it was too easy to miss.
  function notesToggleButton(collapsed, title) {
    return '<button type="button" class="notes-toggle" data-action="toggle-notes" aria-expanded="' + (!collapsed) + '" aria-label="Toggle notes for ' + escapeHtml(title) + '">' + (collapsed ? "▸ more" : "▾ less") + '</button>';
  }

  // Teaser/synopsis (#37): collapsed notes used to just vanish, leaving no
  // hint of what's there. This renders alongside the full notes div with
  // the opposite collapsed state, so exactly one of the two is visible.
  function notesTeaser(notes) {
    return escapeHtml(truncate(notesPlainText(notes), 120));
  }

  // Blocked (#26) is an independent flag, not a status -- own vs. inherited
  // (blockedByDescendant, flowing uphill from a blocked child) get visibly
  // different treatment so you can tell "this is blocked" from "something
  // under this is blocked" at a glance.
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

  function blockedToggleButton(q) {
    return '<button type="button" class="note-btn blocked-btn" data-action="toggle-blocked" data-id="' + escapeHtml(q.id) + '">' + (q.blocked ? "unblock" : "&#9888; block") + '</button>';
  }

  function attentionBadge(q) {
    if (q.attention) return '<span class="attention-badge">🔔 ATTENTION</span>';
    return "";
  }

  function attentionToggleButton(q) {
    return '<button type="button" class="note-btn attention-btn" data-action="toggle-attention" data-id="' + escapeHtml(q.id) + '">' + (q.attention ? "unmark" : "🔔 mark") + '</button>';
  }

  function questRow(q) {
    var checked = q.status === "done";
    var childLevel = childLevelFor(q.level);
    // A flat row is only ever rendered for a childless item (isTreeItem
    // routes anything with children into the tree instead), so promotion is
    // always safe here -- the only gate is not already being a Quest.
    var canPromote = q.level !== "quest";
    return (
      '<div class="quest' + (checked ? " is-done" : "") + blockedClass(q) + '" data-id="' + escapeHtml(q.id) + '">' +
        '<button type="button" class="quest-check" data-action="toggle-done" data-id="' + escapeHtml(q.id) + '" aria-pressed="' + checked + '" aria-label="Mark ' + escapeHtml(q.title) + (checked ? ' not done' : ' done') + '">' +
          (checked ? "[x]" : "[ ]") +
        '</button>' +
        '<div class="quest-title-row">' +
          '<span class="quest-title">' + escapeHtml(q.title) + '</span>' +
          blockedBadge(q) +
          attentionBadge(q) +
          blockedToggleButton(q) +
          attentionToggleButton(q) +
          (canPromote ? '<button type="button" class="note-btn" data-action="promote" data-id="' + escapeHtml(q.id) + '" title="Promote to ' + escapeHtml(LEVEL_UP[q.level]) + '">&uarr; promote</button>' : '') +
          (childLevel ? '<button type="button" class="note-btn" data-action="add-note" data-id="' + escapeHtml(q.id) + '" data-level="' + childLevel + '">+ note</button>' : '') +
        '</div>' +
        (q.notes
          ? '<div class="quest-notes-teaser">' + notesTeaser(q.notes) + ' ' + notesToggleButton(true, q.title) + '</div>' +
            '<div class="quest-notes collapsed">' + sanitizeNotes(q.notes) + (q.date ? ' <span style="opacity:0.6">(' + q.date + ')</span>' : '') + ' ' + notesToggleButton(false, q.title) + '</div>'
          : '<div class="quest-notes"></div>') +
      '</div>'
    );
  }

  // Items that belong to a Quest hierarchy -- a Quest itself, anything with
  // a parentId, or anything that itself has children (an ungrouped Mission
  // with Tasks under it) -- render in the quest tree instead of the flat
  // status panels, since the flat panels' toggle-done button assumes a
  // childless leaf. An "ungrouped" mission/task with no parent and no
  // children is today's flat item and keeps rendering exactly as before.
  function isTreeItem(q, parentIds) {
    return q.level === "quest" || !!q.parentId || parentIds.has(q.id);
  }

  // Child-count badge (#37): shown next to the structural toggle only while
  // collapsed, so a rolled-up Quest/Mission still says what's inside it
  // ("4 missions", "3 tasks, 2 done") instead of giving no hint at all.
  function childCountLabel(q, children) {
    var noun = q.level === "quest" ? "mission" : "task";
    var doneCount = children.filter(function (c) { return c.status === "done"; }).length;
    return children.length + " " + noun + (children.length === 1 ? "" : "s") + (doneCount > 0 ? ", " + doneCount + " done" : "");
  }

  // Read-only by design: a Quest/Mission with children only ever closes via
  // confirm_completion through Claude + the MCP tools (a conversation, not
  // a click) -- so this tree just displays current state, it doesn't offer
  // controls to change it. Every node starts collapsed regardless of level,
  // so the tree shows what Quests/Missions exist without dumping the whole
  // hierarchy on the page at once.
  function treeNode(q, byParent, allQuests) {
    var allChildren = byParent[q.id] || [];
    // Separate active items from done items (#61)
    var activeChildren = allChildren.filter(function (c) { return c.status !== "done"; });
    var doneChildren = allChildren.filter(function (c) { return c.status === "done"; });
    var hasActiveChildren = activeChildren.length > 0;
    var hasDoneChildren = doneChildren.length > 0;
    var checked = q.status === "done";
    var meta = STATUS_META[q.status] || { tag: "UNKNOWN" };
    var childLevel = childLevelFor(q.level);
    // Unlike the flat row, a tree node can have children -- promoting one
    // with children would leave them one tier too deep (see promoteQuest in
    // state.js), so the button only shows once it's actually eligible.
    var canPromote = q.level !== "quest" && allChildren.length === 0;
    var expanded = false;
    // Per-quest progress bar (#29): each top-level Quest shows its own
    // completion status (its Missions/Tasks: done vs. total within that Quest only)
    var progress = q.level === "quest" ? questProgress(q, allQuests) : null;

    // Render active children and done children separately (#61)
    var childrenHtml = '';
    if (hasActiveChildren) {
      childrenHtml += activeChildren.map(function (c) { return treeNode(c, byParent, allQuests); }).join("");
    }
    if (hasDoneChildren) {
      var completedExpanded = false;
      childrenHtml += '<div class="tree-completed' + (completedExpanded ? "" : " collapsed") + '">' +
        '<button type="button" class="tree-toggle" data-action="toggle-tree" aria-expanded="' + completedExpanded + '" aria-label="Toggle Completed">' + (completedExpanded ? "▾" : "▸") + '</button>' +
        '<span class="completed-label">Completed (' + doneChildren.length + ')</span>' +
        '<div class="tree-completed-items' + (completedExpanded ? "" : " collapsed") + '">' +
        doneChildren.map(function (c) { return treeNode(c, byParent, allQuests); }).join("") +
        '</div>' +
        '</div>';
    }

    var hasChildren = allChildren.length > 0;

    return (
      '<div class="tree-node' + (checked ? " is-done" : "") + blockedClass(q) + '" data-id="' + escapeHtml(q.id) + '">' +
        '<div class="tree-row">' +
          '<span class="tree-title-group">' +
            (hasChildren
              ? '<button type="button" class="tree-toggle" data-action="toggle-tree" aria-expanded="' + expanded + '" aria-label="Toggle ' + escapeHtml(q.title) + '">' + (expanded ? "▾" : "▸") + '</button>' +
                '<span class="child-count' + (expanded ? " collapsed" : "") + '">(' + escapeHtml(childCountLabel(q, allChildren)) + ')</span>'
              : '<span class="tree-toggle-spacer"></span>') +
            '<span class="tree-title">' + escapeHtml(q.title) + '</span>' +
            blockedBadge(q) +
          '</span>' +
          '<span class="tree-actions">' +
            '<span class="tree-meta">' + escapeHtml(q.level) + '</span>' +
            (hasChildren && q.readyToClose ? '<span class="ready-badge">Ready to close</span>' : '<span class="quest-tag">' + meta.tag + '</span>') +
            attentionBadge(q) +
            blockedToggleButton(q) +
            attentionToggleButton(q) +
            (canPromote ? '<button type="button" class="note-btn" data-action="promote" data-id="' + escapeHtml(q.id) + '" title="Promote to ' + escapeHtml(LEVEL_UP[q.level]) + '">&uarr; promote</button>' : '') +
            (childLevel ? '<button type="button" class="note-btn" data-action="add-note" data-id="' + escapeHtml(q.id) + '" data-level="' + childLevel + '">+ note</button>' : '') +
          '</span>' +
        '</div>' +
        (progress
          ? '<div class="quest-progress"><span class="progress-label">' + progress.done + '/' + progress.total + '</span><div class="bar-track"><div class="bar-fill" style="width:' + progress.pct + '%"></div></div></div>'
          : '') +
        (q.notes
          ? '<div class="tree-notes-teaser">' + notesTeaser(q.notes) + ' ' + notesToggleButton(true, q.title) + '</div>' +
            '<div class="tree-notes collapsed">' + sanitizeNotes(q.notes) + (q.date ? ' <span style="opacity:0.6">(' + q.date + ')</span>' : '') + ' ' + notesToggleButton(false, q.title) + '</div>'
          : '') +
        (hasChildren ? '<div class="tree-children' + (expanded ? "" : " collapsed") + '">' + childrenHtml + '</div>' : '') +
      '</div>'
    );
  }

  function renderQuestTree(state, parentIds) {
    var panel = document.getElementById("quests-panel");
    var byParent = {};
    state.quests.forEach(function (q) {
      if (!q.parentId) return;
      (byParent[q.parentId] = byParent[q.parentId] || []).push(q);
    });
    // Roots are real Quests, plus any parentless item that itself has
    // children (an ungrouped Mission with Tasks under it) -- otherwise it
    // would be excluded from the flat panels but never shown anywhere.
    var roots = state.quests.filter(function (q) {
      return !q.parentId && (q.level === "quest" || parentIds.has(q.id));
    });
    // Always visible now (the hierarchy view is meant to be the primary
    // one), with an empty state when there's no Quest yet rather than
    // hiding the whole panel.
    panel.hidden = false;
    document.getElementById("quest-tree").innerHTML = roots.length
      ? roots.map(function (q) { return treeNode(q, byParent, state.quests); }).join("")
      : '<div class="empty-row">// no Quests yet -- promote a Mission below (&uarr;), or ask Claude to recruit one</div>';
    document.getElementById("count-quests").textContent = "[" + roots.length + "]";
  }

  function render(state) {
    var parentIds = new Set();
    state.quests.forEach(function (q) { if (q.parentId) parentIds.add(q.parentId); });

    // Flat panels are down to just the Idea Board now (#30 cleanup): ACTIVE
    // and COMPLETED never earned their keep once the hierarchy took over
    // "what's active," and BLOCKED became a cross-cutting flag (#26) instead
    // of a status. progress/done are still tracked here (for the Mission
    // Progress bar below) even though only idea gets its own panel.
    var groups = { progress: [], idea: [], done: [] };
    state.quests.forEach(function (q) {
      if (isTreeItem(q, parentIds)) return;
      if (!groups[q.status]) {
        console.warn("quest with unrecognized status, skipping:", q.id, q.status);
        return;
      }
      groups[q.status].push(q);
    });

    renderQuestTree(state, parentIds);

    var ideaList = document.getElementById("list-idea");
    ideaList.innerHTML = groups.idea.length
      ? groups.idea.map(questRow).join("")
      : '<div class="empty-row">// none</div>';
    document.getElementById("count-idea").textContent = "[" + groups.idea.length + "]";

    // Sidebar widget (#21): a handful of the most recent entries only, each
    // truncated -- plus an unroll control (#30) to see the untruncated full
    // history on demand, since that used to be its own always-visible panel.
    var flatLog = [];
    state.log.forEach(function (day) {
      for (var i = day.entries.length - 1; i >= 0; i--) flatLog.push({ date: day.date, text: day.entries[i] });
    });
    var logMini = document.getElementById("log-body-mini");
    if (logMini) {
      var recent = flatLog.slice(0, 6);
      logMini.innerHTML = recent.length
        ? recent.map(function (item) {
            return '<li><span class="log-mini-date">' + escapeHtml(item.date) + '</span>' + escapeHtml(truncate(item.text, 90)) + '</li>';
          }).join("")
        : '<li class="empty-row">// no recent activity</li>';
    }
    var logFull = document.getElementById("log-body-full");
    if (logFull) {
      logFull.innerHTML = state.log.map(function (day) {
        return '<div class="log-full-date">' + escapeHtml(day.date) + '</div>' +
          '<ul class="log-full-list">' + day.entries.map(function (e) { return "<li>" + escapeHtml(e) + "</li>"; }).join("") + '</ul>';
      }).join("");
    }

    var bootTime = document.getElementById("boot-time");
    if (bootTime) bootTime.textContent = state.quests.length + " MISSIONS TRACKED";

    applyFlavor();
  }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // Completing a flat item no longer moves it to a Completed panel (#30) --
  // it just drops off the Idea Board, with this taking its place as the
  // record of what happened. Mirrors add_log_entry's day-bucketing server-side.
  function pushLogEntry(text) {
    var day = todayISO();
    var logDay = STATE.log.find(function (d) { return d.date === day; });
    if (!logDay) {
      logDay = { date: day, entries: [] };
      STATE.log.unshift(logDay);
    }
    logDay.entries.push(text);
  }

  var THEME_KEY = "questlog-theme";
  var themeSelect = document.getElementById("theme-select");
  if (themeSelect) {
    themeSelect.value = document.documentElement.dataset.theme || "muthur";
    themeSelect.addEventListener("change", function () {
      var theme = themeSelect.value;
      if (theme === "muthur") {
        delete document.documentElement.dataset.theme;
      } else {
        document.documentElement.dataset.theme = theme;
      }
      try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
      applyFlavor();
    });
  }

  // Designation is set once on first visit, then locked (#33): once a name
  // has been saved, the whole field hides itself rather than just going
  // read-only, since a locked-but-visible input invites retyping attempts
  // that quietly do nothing. The first save persists to the server (via the
  // normal /api/state save path) rather than staying localStorage-only, so
  // it's readable from -- and changeable via -- the set_designation MCP
  // tool afterward instead of the field needing to stay editable.
  var nameInput = document.getElementById("name-input");
  if (nameInput) {
    var savedName = currentDesignationName();
    nameInput.value = savedName;
    if (savedName) {
      var nameRow = nameInput.closest(".switcher-row");
      if (nameRow) nameRow.style.display = "none";
    } else {
      nameInput.addEventListener("input", function () {
        try { localStorage.setItem(NAME_KEY, nameInput.value); } catch (e) {}
        applyFlavor();
      });
      nameInput.addEventListener("change", function () {
        var v = nameInput.value.trim();
        if (!v) return;
        STATE.designation = v;
        persist();
      });
    }
  }

  var STATE = window.__QUEST_STATE__ || { quests: [], log: [] };
  var saveIndicator = document.getElementById("save-indicator");
  var saveTimer = null;

  function showSaveState(text, isError) {
    if (!saveIndicator) return;
    saveIndicator.textContent = text;
    saveIndicator.classList.toggle("error", !!isError);
    saveIndicator.classList.add("visible");
    clearTimeout(saveTimer);
    if (!isError) {
      saveTimer = setTimeout(function () { saveIndicator.classList.remove("visible"); }, 1500);
    }
  }

  function persist() {
    render(STATE);
    showSaveState("saving...", false);
    fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Write-Token": window.__WRITE_TOKEN__ || "" },
      body: JSON.stringify(STATE)
    })
      .then(function (res) {
        if (res.status === 409) {
          showSaveState("conflict - someone else changed this, reload the page", true);
          throw new Error("conflict");
        }
        if (!res.ok) throw new Error("save failed (" + res.status + ")");
        return res.json();
      })
      .then(function (body) {
        STATE._version = body.version;
        showSaveState("saved", false);
      })
      .catch(function (err) {
        if (err.message !== "conflict") {
          console.error(err);
          showSaveState("save failed - retry or check server", true);
        }
      });
  }

  document.addEventListener("click", function (ev) {
    var notesToggleBtn = ev.target.closest('[data-action="toggle-notes"]');
    if (notesToggleBtn) {
      // Two of these buttons exist per item now (#37) -- one trailing the
      // teaser, one trailing the full text -- each with a static label
      // matching its own fixed role, so only the collapsed classes need
      // to flip; whichever button is visible already reads correctly.
      var notesContainer = notesToggleBtn.closest(".tree-node, .quest");
      var notesEl = notesContainer && notesContainer.querySelector(":scope > .tree-notes, :scope > .quest-notes");
      var teaserEl = notesContainer && notesContainer.querySelector(":scope > .tree-notes-teaser, :scope > .quest-notes-teaser");
      if (notesEl && teaserEl) {
        var notesCollapsed = notesEl.classList.toggle("collapsed");
        teaserEl.classList.toggle("collapsed", !notesCollapsed);
      }
      return;
    }
    var treeToggleBtn = ev.target.closest('[data-action="toggle-tree"]');
    if (treeToggleBtn) {
      // Handle both regular tree nodes and completed sections (#61)
      var node = treeToggleBtn.closest(".tree-node");
      var completed = treeToggleBtn.closest(".tree-completed");
      var kids;
      if (completed) {
        // For completed sections, toggle both the section and the items container
        kids = completed.querySelector(":scope > .tree-completed-items");
        if (kids) {
          completed.classList.toggle("collapsed");
        }
      } else if (node) {
        // For regular tree nodes, toggle the children
        kids = node.querySelector(":scope > .tree-children");
      }
      if (kids) {
        var collapsed = kids.classList.toggle("collapsed");
        treeToggleBtn.textContent = collapsed ? "▸" : "▾";
        treeToggleBtn.setAttribute("aria-expanded", String(!collapsed));
        var countEl = treeToggleBtn.parentNode.querySelector(":scope > .child-count");
        if (countEl) countEl.classList.toggle("collapsed", !collapsed);
      }
      return;
    }
    var toggleBtn = ev.target.closest('[data-action="toggle-done"]');
    if (toggleBtn) {
      var id = toggleBtn.getAttribute("data-id");
      var q = STATE.quests.find(function (x) { return x.id === id; });
      if (!q) return;
      if (q.status === "done") {
        q.status = q._prevStatus || "idea";
      } else {
        q._prevStatus = q.status;
        q.status = "done";
        q.date = q.date || todayISO();
        delete q.blocked;
        pushLogEntry("✓ " + q.title + " completed");
      }
      persist();
      requestAnimationFrame(function () {
        var el = document.querySelector('.quest-check[data-id="' + CSS.escape(id) + '"]');
        if (el) { el.classList.add("just-toggled"); setTimeout(function () { el.classList.remove("just-toggled"); }, 400); }
      });
      return;
    }
    var blockedBtn = ev.target.closest('[data-action="toggle-blocked"]');
    if (blockedBtn) {
      var bid = blockedBtn.getAttribute("data-id");
      var bq = STATE.quests.find(function (x) { return x.id === bid; });
      if (!bq) return;
      if (bq.blocked) delete bq.blocked;
      else bq.blocked = true;
      persist();
      return;
    }
    var attentionBtn = ev.target.closest('[data-action="toggle-attention"]');
    if (attentionBtn) {
      var aid = attentionBtn.getAttribute("data-id");
      var aq = STATE.quests.find(function (x) { return x.id === aid; });
      if (!aq) return;
      if (aq.attention) delete aq.attention;
      else aq.attention = true;
      persist();
      return;
    }
    var logUnrollBtn = ev.target.closest('[data-action="toggle-log-full"]');
    if (logUnrollBtn) {
      var logFullEl = document.getElementById("log-body-full");
      if (logFullEl) {
        var logCollapsed = logFullEl.classList.toggle("collapsed");
        logUnrollBtn.textContent = logCollapsed ? "Show full log ▾" : "Hide full log ▴";
        logUnrollBtn.setAttribute("aria-expanded", String(!logCollapsed));
      }
      return;
    }
    var promoteBtn = ev.target.closest('[data-action="promote"]');
    if (promoteBtn) {
      var pid = promoteBtn.getAttribute("data-id");
      var pq = STATE.quests.find(function (x) { return x.id === pid; });
      if (!pq || !LEVEL_UP[pq.level]) return;
      var oldParent = pq.parentId ? STATE.quests.find(function (x) { return x.id === pq.parentId; }) : null;
      var newLevel = LEVEL_UP[pq.level];
      pq.level = newLevel;
      pq.parentId = newLevel === "quest" ? null : (oldParent ? (oldParent.parentId || null) : null);
      persist();
      return;
    }
    var noteBtn = ev.target.closest('[data-action="add-note"]');
    if (noteBtn) {
      var parentId = noteBtn.getAttribute("data-id");
      var level = noteBtn.getAttribute("data-level");
      var text = window.prompt("Quick note (Claude will sort it out later):");
      if (!text) return;
      text = text.trim();
      if (!text) return;
      STATE.quests.push({
        id: level + "-" + Date.now().toString(36),
        title: text,
        status: "idea",
        notes: "",
        level: level,
        parentId: parentId
      });
      persist();
      return;
    }
  });

  var addForm = document.getElementById("add-form");
  if (addForm) {
    addForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var input = document.getElementById("add-input");
      var title = input.value.trim();
      if (!title) return;
      STATE.quests.push({
        id: "idea-" + Date.now().toString(36),
        title: title,
        status: "idea",
        notes: "",
        level: "mission",
        parentId: null
      });
      input.value = "";
      persist();
    });
  }

  render(STATE);
})();
