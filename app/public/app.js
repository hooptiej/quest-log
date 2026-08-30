(function () {
  "use strict";

  var STATUS_META = {
    progress: { tag: "ACTIVE" },
    idea: { tag: "IDEA" },
    blocked: { tag: "BLOCKED" },
    done: { tag: "DONE" }
  };
  var CYCLE_ORDER = ["idea", "progress", "blocked"];

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function questRow(q) {
    var meta = STATUS_META[q.status];
    var checked = q.status === "done";
    var showCycle = !checked;
    return (
      '<div class="quest' + (checked ? " is-done" : "") + '" data-id="' + escapeHtml(q.id) + '">' +
        '<button type="button" class="quest-check" data-action="toggle-done" data-id="' + escapeHtml(q.id) + '" aria-pressed="' + checked + '" aria-label="Mark ' + escapeHtml(q.title) + (checked ? ' not done' : ' done') + '">' +
          (checked ? "[x]" : "[ ]") +
        '</button>' +
        '<div class="quest-title-row">' +
          '<span class="quest-title">' + escapeHtml(q.title) + '</span>' +
          (checked ? '<span class="quest-tag">' + meta.tag + '</span>' : '') +
        '</div>' +
        (q.notes ? '<div class="quest-notes">' + q.notes + (q.date ? ' <span style="opacity:0.6">(' + q.date + ')</span>' : '') + '</div>' : '<div class="quest-notes"></div>') +
        (showCycle ? '<button type="button" class="quest-cycle" data-action="cycle-status" data-id="' + escapeHtml(q.id) + '">' + meta.tag + '</button>' : '<span></span>') +
      '</div>'
    );
  }

  function render(state) {
    var groups = { progress: [], idea: [], blocked: [], done: [] };
    state.quests.forEach(function (q) { groups[q.status].push(q); });

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
      headers: { "Content-Type": "application/json" },
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
        notes: ""
      });
      input.value = "";
      persist();
    });
  }

  render(STATE);
})();
