(function () {
  "use strict";

  var STATUS_META = {
    progress: { tag: "ACTIVE" },
    idea: { tag: "IDEA" },
    blocked: { tag: "BLOCKED" },
    done: { tag: "DONE" }
  };
  var CYCLE_ORDER = ["idea", "progress", "blocked"];
  // Mirrors state.js's LEVEL_UP -- what promote() steps a level up to.
  var LEVEL_UP = { task: "mission", mission: "quest" };

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

  // A quest/mission can take a child note; a task (already a leaf) can't.
  function childLevelFor(level) {
    if (level === "quest") return "mission";
    if (level === "mission") return "task";
    return null;
  }

  function questRow(q) {
    var meta = STATUS_META[q.status] || { tag: "UNKNOWN" };
    var checked = q.status === "done";
    var showCycle = !checked;
    var childLevel = childLevelFor(q.level);
    // A flat row is only ever rendered for a childless item (isTreeItem
    // routes anything with children into the tree instead), so promotion is
    // always safe here -- the only gate is not already being a Quest.
    var canPromote = q.level !== "quest";
    return (
      '<div class="quest' + (checked ? " is-done" : "") + '" data-id="' + escapeHtml(q.id) + '">' +
        '<button type="button" class="quest-check" data-action="toggle-done" data-id="' + escapeHtml(q.id) + '" aria-pressed="' + checked + '" aria-label="Mark ' + escapeHtml(q.title) + (checked ? ' not done' : ' done') + '">' +
          (checked ? "[x]" : "[ ]") +
        '</button>' +
        '<div class="quest-title-row">' +
          '<span class="quest-title">' + escapeHtml(q.title) + '</span>' +
          (checked ? '<span class="quest-tag">' + meta.tag + '</span>' : '') +
          (canPromote ? '<button type="button" class="note-btn" data-action="promote" data-id="' + escapeHtml(q.id) + '" title="Promote to ' + escapeHtml(LEVEL_UP[q.level]) + '">&uarr; promote</button>' : '') +
          (childLevel ? '<button type="button" class="note-btn" data-action="add-note" data-id="' + escapeHtml(q.id) + '" data-level="' + childLevel + '">+ note</button>' : '') +
        '</div>' +
        (q.notes ? '<div class="quest-notes">' + sanitizeNotes(q.notes) + (q.date ? ' <span style="opacity:0.6">(' + q.date + ')</span>' : '') + '</div>' : '<div class="quest-notes"></div>') +
        (showCycle ? '<button type="button" class="quest-cycle" data-action="cycle-status" data-id="' + escapeHtml(q.id) + '">' + meta.tag + '</button>' : '<span></span>') +
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

  // Read-only by design: a Quest/Mission with children only ever closes via
  // confirm_completion through Claude + the MCP tools (a conversation, not
  // a click) -- so this tree just displays current state, it doesn't offer
  // controls to change it.
  function treeNode(q, byParent) {
    var children = byParent[q.id] || [];
    var checked = q.status === "done";
    var hasChildren = children.length > 0;
    var meta = STATUS_META[q.status] || { tag: "UNKNOWN" };
    var childLevel = childLevelFor(q.level);
    // Unlike the flat row, a tree node can have children -- promoting one
    // with children would leave them one tier too deep (see promoteQuest in
    // state.js), so the button only shows once it's actually eligible.
    var canPromote = q.level !== "quest" && !hasChildren;
    return (
      '<div class="tree-node' + (checked ? " is-done" : "") + '" data-id="' + escapeHtml(q.id) + '">' +
        '<div class="tree-row">' +
          '<span class="tree-title">' + escapeHtml(q.title) + '</span>' +
          '<span class="tree-actions">' +
            '<span class="tree-meta">' + escapeHtml(q.level) + '</span>' +
            (hasChildren && q.readyToClose ? '<span class="ready-badge">Ready to close</span>' : '<span class="quest-tag">' + meta.tag + '</span>') +
            (canPromote ? '<button type="button" class="note-btn" data-action="promote" data-id="' + escapeHtml(q.id) + '" title="Promote to ' + escapeHtml(LEVEL_UP[q.level]) + '">&uarr; promote</button>' : '') +
            (childLevel ? '<button type="button" class="note-btn" data-action="add-note" data-id="' + escapeHtml(q.id) + '" data-level="' + childLevel + '">+ note</button>' : '') +
          '</span>' +
        '</div>' +
        (q.notes ? '<div class="tree-notes">' + sanitizeNotes(q.notes) + (q.date ? ' <span style="opacity:0.6">(' + q.date + ')</span>' : '') + '</div>' : '') +
        (hasChildren ? '<div class="tree-children">' + children.map(function (c) { return treeNode(c, byParent); }).join("") + '</div>' : '') +
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
      ? roots.map(function (q) { return treeNode(q, byParent); }).join("")
      : '<div class="empty-row">// no Quests yet -- promote a Mission below (&uarr;), or ask Claude to recruit one</div>';
    document.getElementById("count-quests").textContent = "[" + roots.length + "]";
  }

  function render(state) {
    var parentIds = new Set();
    state.quests.forEach(function (q) { if (q.parentId) parentIds.add(q.parentId); });

    var groups = { progress: [], idea: [], blocked: [], done: [] };
    state.quests.forEach(function (q) {
      if (isTreeItem(q, parentIds)) return;
      if (!groups[q.status]) {
        console.warn("quest with unrecognized status, skipping:", q.id, q.status);
        return;
      }
      groups[q.status].push(q);
    });

    renderQuestTree(state, parentIds);

    var total = state.quests.length;
    var doneCount = groups.done.length;
    var pct = total ? Math.round((doneCount / total) * 100) : 0;

    document.getElementById("status-pct").textContent = pct + "%";
    document.getElementById("bar-fill").style.width = pct + "%";
    document.getElementById("status-counts").innerHTML =
      '<span class="c-active">ACTIVE <b>' + groups.progress.length + '</b></span>' +
      '<span class="c-idea">IDEAS <b>' + groups.idea.length + '</b></span>' +
      '<span class="c-blocked">BLOCKED <b>' + groups.blocked.length + '</b></span>' +
      '<span class="c-done">DONE <b>' + groups.done.length + '</b></span>';

    function fill(id, list) {
      var el = document.getElementById(id);
      el.innerHTML = list.length
        ? list.map(questRow).join("")
        : '<div class="empty-row">// none</div>';
    }
    fill("list-progress", groups.progress);
    fill("list-idea", groups.idea);
    fill("list-blocked", groups.blocked);
    fill("list-done", groups.done);

    document.getElementById("count-progress").textContent = "[" + groups.progress.length + "]";
    document.getElementById("count-idea").textContent = "[" + groups.idea.length + "]";
    document.getElementById("count-blocked").textContent = "[" + groups.blocked.length + "]";
    document.getElementById("count-done").textContent = "[" + groups.done.length + "]";

    var logBody = document.getElementById("log-body");
    logBody.innerHTML = state.log.map(function (day) {
      return '<div class="log-entry-date">' + day.date + '</div>' +
        '<ul class="log-list">' + day.entries.map(function (e) { return "<li>" + escapeHtml(e) + "</li>"; }).join("") + '</ul>';
    }).join("");

    var bootTime = document.getElementById("boot-time");
    if (bootTime) bootTime.textContent = total + " MISSIONS TRACKED";
  }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
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
    });
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
    var toggleBtn = ev.target.closest('[data-action="toggle-done"]');
    if (toggleBtn) {
      var id = toggleBtn.getAttribute("data-id");
      var q = STATE.quests.find(function (x) { return x.id === id; });
      if (!q) return;
      if (q.status === "done") {
        q.status = q._prevStatus || "progress";
      } else {
        q._prevStatus = q.status;
        q.status = "done";
        q.date = q.date || todayISO();
      }
      persist();
      requestAnimationFrame(function () {
        var el = document.querySelector('.quest-check[data-id="' + CSS.escape(id) + '"]');
        if (el) { el.classList.add("just-toggled"); setTimeout(function () { el.classList.remove("just-toggled"); }, 400); }
      });
      return;
    }
    var cycleBtn = ev.target.closest('[data-action="cycle-status"]');
    if (cycleBtn) {
      var cid = cycleBtn.getAttribute("data-id");
      var cq = STATE.quests.find(function (x) { return x.id === cid; });
      if (!cq) return;
      var idx = CYCLE_ORDER.indexOf(cq.status);
      cq.status = CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length];
      persist();
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
