import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  readState,
  mutateState,
  todayISO,
  nowISO,
  slugify,
  describeQuest,
  resolveOne,
  resolveParent,
  confirmCompletion,
  promoteQuest,
  recruitQuest,
  transferQuest,
  deleteQuest,
  moveQuest,
  renameQuest,
  setDesignation,
  getMaintenance,
  setMaintenance,
  getAutoLog,
  setAutoLog,
  setSettingsMode,
  setProMode,
  getProMode,
  setBlocked,
  setArchived,
  setAttention,
  touchQuestAncestor,
  appendTicketTouch,
  appendTicketView,
  attachHaloTicket,
  getTicketStats,
} from "../state.js";

const LEVELS = ["quest", "mission", "task"];

// Write-layer guard against dangerous HTML/script sequences in user content
// (#57). Rejects notes/content containing sequences that could escape the
// inline <script> block even if render-side escaping is misconfigured. This
// is defense in depth; render-side escaping in app/server.js is the primary
// protection. Returns null if content is safe, or an error message if not.
function validateNoteContent(content) {
  if (!content || typeof content !== "string") return null;
  // Check for script-breaking sequences that could escape the inline block
  // and inject code, even if render-side escaping is temporarily disabled.
  // Case-insensitive to match #57's ask -- browsers close </script> tags
  // case-insensitively, so </SCRIPT> is just as dangerous as </script>.
  const lower = content.toLowerCase();
  if (lower.includes("</script")) {
    return "notes cannot contain '</script' (would break HTML script block)";
  }
  if (lower.includes("<!--")) {
    return "notes cannot contain '<!--' (would break HTML script block)";
  }
  return null;
}

// Prepended to a read tool's response when maintenance is flagged, so a
// session sees the heads-up on whatever it happens to call next rather than
// needing to know to check a specific tool.
function withMaintenanceBanner(state, content) {
  const m = getMaintenance(state);
  if (!m.active) return content;
  const note = m.note ? `: ${m.note}` : "";
  return [{ type: "text", text: `⚠️ quest-log maintenance flagged since ${m.since}${note}` }, ...content];
}

// Prepended to read tools' responses when any items have the attention flag set,
// so a session is nudged to actively follow up on those items. Follows the
// pattern of withMaintenanceBanner.
function withAttentionInfo(state, content) {
  const attentionItems = state.quests.filter((q) => q.attention);
  if (attentionItems.length === 0) return content;
  const titles = attentionItems.slice(0, 5).map((q) => `"${q.title}"`).join(", ");
  const more = attentionItems.length > 5 ? ` and ${attentionItems.length - 5} more` : "";
  return [{ type: "text", text: `🔔 ${attentionItems.length} item(s) flagged for attention: ${titles}${more}` }, ...content];
}

// Runs a single-item op shaped like recruitQuest/transferQuest --
// (state, idOrTitle, newParentIdOrTitle) => { quest } | { error } -- across
// one id or a whole array of ids against the same new parent, inside one
// mutateState call (#24's bulk nice-to-have): a single save/version bump for
// the whole batch instead of one per item, and each id is attempted
// independently so one failure doesn't stop the rest from landing. A single
// (non-array) idOrTitle keeps the original single-result response shape for
// backward compatibility; an array gets a per-item array response instead.
async function runBatch(op, idOrTitleOrList, newParentIdOrTitle) {
  const ids = Array.isArray(idOrTitleOrList) ? idOrTitleOrList : [idOrTitleOrList];
  const { result } = await mutateState(async (state) => {
    const outcomes = ids.map((id) => ({ idOrTitle: id, ...op(state, id, newParentIdOrTitle) }));
    outcomes.forEach((o) => {
      if (!o.error) touchQuestAncestor(state, o.quest);
    });
    return outcomes;
  });
  if (!Array.isArray(idOrTitleOrList)) {
    const [only] = result;
    if (only.error) return { content: [{ type: "text", text: only.error }], isError: true };
    // Strip the echoed idOrTitle, keep every other field the op returned --
    // moveQuest's result also carries `moved` (the whole shifted subtree),
    // which recruitQuest/transferQuest's `{ quest }`-only shape doesn't have,
    // so this generalizes to both without changing recruit/transfer's output.
    const { idOrTitle, ...rest } = only;
    return { content: [{ type: "text", text: JSON.stringify(rest, null, 2) }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

function createServer(options = {}) {
  const env = options.env ?? "prod";
  const serverName = env === "dev" ? "questhelper-dev" : "questhelper";
  const server = new McpServer({ name: serverName, version: "1.0.0" });

  server.tool(
    "list_quests",
    "List quests from the quest log, optionally filtered by status and/or level (quest/mission/task). Each quest includes a createdAt timestamp for tracking when it was created. By default, archived items are excluded; pass archived:true to see only archived items or archived:false to see only non-archived items. For a full-log review, prefer openOnly/orphaned/summary over pulling everything unfiltered -- the unfiltered response grows with the log and can exceed tool-result size limits.",
    {
      status: z.enum(["idea", "progress", "done"]).optional().describe("Filter to just this status"),
      level: z.enum(LEVELS).optional().describe("Filter to just this level"),
      blocked: z.boolean().optional().describe("Filter to only blocked (true) or only unblocked (false) quests"),
      archived: z.boolean().optional().describe("Filter to only archived (true) or only non-archived (false) quests. Default (undefined) excludes archived items from results."),
      attention: z.boolean().optional().describe("Filter to only attention-flagged (true) or only non-flagged (false) quests"),
      orphaned: z
        .boolean()
        .optional()
        .describe(
          "Filter to Missions/Tasks with no parent (true) or with a parent (false) -- Quests are always excluded by this filter either way, since top-level is their normal, deliberate placement. Use true to audit for items that were probably meant to be nested under something (#108/#109).",
        ),
      openOnly: z.boolean().optional().describe("Shortcut to exclude done items (keep only status idea/progress). Combines with status/level/etc; redundant if status is also given."),
      summary: z.boolean().optional().describe("Omit each item's notes text from the response -- use when you just need titles/status/hierarchy and want to avoid a large payload from long notes fields (#109)."),
      tree: z.boolean().optional().describe("Return nested (quest -> missions -> tasks) instead of a flat list"),
      sortByCreatedAtDesc: z.boolean().optional().describe("Sort by createdAt descending (newest first). Only applies to flat list (tree: false)"),
    },
    async ({ status, level, blocked, archived, attention, orphaned, openOnly, summary, tree, sortByCreatedAtDesc }) => {
      const state = await readState();
      let quests = state.quests;
      if (status) quests = quests.filter((q) => q.status === status);
      if (openOnly) quests = quests.filter((q) => q.status !== "done");
      if (level) quests = quests.filter((q) => q.level === level);
      if (blocked !== undefined) quests = quests.filter((q) => !!q.blocked === blocked);
      if (attention !== undefined) quests = quests.filter((q) => !!q.attention === attention);
      if (orphaned !== undefined) quests = quests.filter((q) => q.level !== "quest" && (q.parentId == null) === orphaned);
      // Default behavior: exclude archived items unless explicitly requested.
      // archived === false behaves the same as undefined (both mean "only
      // non-archived") -- only archived === true flips to archived-only.
      quests = archived === true
        ? quests.filter((q) => !!q.archived)
        : quests.filter((q) => !q.archived);
      if (sortByCreatedAtDesc && !tree) {
        quests = quests.sort((a, b) => {
          const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return bTime - aTime;
        });
      }
      if (summary) quests = quests.map(({ notes, ...rest }) => rest);
      if (!tree) return { content: withMaintenanceBanner(state, withAttentionInfo(state, [{ type: "text", text: JSON.stringify(quests, null, 2) }])) };

      const byParent = new Map();
      for (const q of quests) {
        const key = q.parentId ?? null;
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(q);
      }
      const attachChildren = (q) => ({ ...q, children: (byParent.get(q.id) ?? []).map(attachChildren) });
      const roots = (byParent.get(null) ?? []).map(attachChildren);
      return { content: withMaintenanceBanner(state, withAttentionInfo(state, [{ type: "text", text: JSON.stringify(roots, null, 2) }])) };
    },
  );

  server.tool(
    "add_idea",
    "Add a new idea/project/task to the quest log's idea board.",
    {
      title: z.string().describe("Short title for the idea"),
      notes: z.string().optional().describe("Optional description/context"),
      status: z.enum(["idea", "progress", "done"]).optional().describe("Defaults to 'idea'"),
      level: z.enum(LEVELS).optional().describe("Defaults to 'mission' (today's flat items are all missions)"),
      parentIdOrTitle: z
        .string()
        .optional()
        .describe("Parent's id, exact title, or a title substring -- a mission's parent must be a quest, a task's must be a mission"),
      repo: z.string().optional().describe("#64: 'owner/repo' this quest tracks a GitHub issue in, e.g. for one item in a serialized batch run"),
      issueNumber: z.number().optional().describe("#64: the GitHub issue number this quest tracks, paired with repo"),
    },
    async ({ title, notes, status, level, parentIdOrTitle, repo, issueNumber }) => {
      // Write-layer guard: reject dangerous note content (#57)
      const noteValidation = validateNoteContent(notes);
      if (noteValidation) {
        return { content: [{ type: "text", text: noteValidation }], isError: true };
      }

      const { result } = await mutateState(async (state) => {
        const questLevel = level ?? "mission";
        const parentResolution = resolveParent(state, parentIdOrTitle, questLevel);
        if (parentResolution.error) return parentResolution;
        const q = {
          id: slugify(title),
          title,
          status: status ?? "idea",
          notes: notes ?? "",
          level: questLevel,
          parentId: parentResolution.parentId,
          createdAt: nowISO(),
        };
        if (repo !== undefined) q.repo = repo;
        if (issueNumber !== undefined) q.issueNumber = issueNumber;
        if (q.status === "done") q.date = todayISO();
        state.quests.push(q);
        if (parentResolution.parentId) touchQuestAncestor(state, q);
        return { quest: q };
      });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.quest, null, 2) }] };
    },
  );

  server.tool(
    "set_quest_status",
    "Update an existing quest's status by id or (partial, case-insensitive) title match. A mission/quest that has children can't be set to 'done' this way -- use confirm_completion once it's readyToClose.",
    {
      idOrTitle: z.string().describe("Quest id, exact title, or a substring of the title"),
      status: z.enum(["idea", "progress", "done"]),
    },
    async ({ idOrTitle, status }) => {
      const { result } = await mutateState(async (state) => {
        const resolved = resolveOne(state, idOrTitle);
        if (resolved.error) return resolved;
        const quest = resolved.quest;
        if (status === "done") {
          const hasChildren = state.quests.some((c) => c.parentId === quest.id);
          if (hasChildren) {
            return { error: `${describeQuest(quest)} has children -- use confirm_completion instead of setting "done" directly` };
          }
          if (quest.status !== "done") {
            quest._prevStatus = quest.status;
            quest.date = quest.date ?? todayISO();
          }
          delete quest.blocked; // done implies no longer blocked
        }
        quest.status = status;
        touchQuestAncestor(state, quest);
        return { quest };
      });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.quest, null, 2) }] };
    },
  );

  server.tool(
    "set_blocked",
    "Set or clear the independent 'blocked' flag (#26) on a quest at any level, without touching its actual status -- something can be 'in progress but blocked'. Blocked flows uphill for display: a blocked Task marks its Mission and Quest too (see blockedByDescendant in get_full_state/list_quests), but only the item you call this on actually stores the flag.",
    {
      idOrTitle: z.string().describe("Quest id, exact title, or a substring of the title"),
      blocked: z.boolean().describe("true to flag it blocked, false to clear it"),
    },
    async ({ idOrTitle, blocked }) => {
      const { result } = await mutateState(async (state) => {
        const outcome = setBlocked(state, idOrTitle, blocked);
        if (!outcome.error) {
          touchQuestAncestor(state, outcome.quest);
        }
        return outcome;
      });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.quest, null, 2) }] };
    },
  );

  server.tool(
    "set_archived",
    "Set or clear the independent 'archived' flag (#61) on a quest at any level. Archived items are genuinely hidden from the default view (unlike 'done' items which are sorted to the bottom in a collapsed Completed section) -- use this to park completed items you don't want cluttering even the collapsed view. Archived items still exist in the data and are reachable via list_quests with archived:true, but don't appear in the normal UI or default tool output.",
    {
      idOrTitle: z.string().describe("Quest id, exact title, or a substring of the title"),
      archived: z.boolean().describe("true to archive it, false to unarchive it"),
    },
    async ({ idOrTitle, archived }) => {
      const { result } = await mutateState(async (state) => {
        const outcome = setArchived(state, idOrTitle, archived);
        if (!outcome.error) {
          touchQuestAncestor(state, outcome.quest);
        }
        return outcome;
      });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.quest, null, 2) }] };
    },
  );

  server.tool(
    "set_attention",
    "Set or clear the independent 'attention' flag (#60) on a quest at any level. Attention-flagged items are surfaced in read-tool outputs as items needing active follow-up, a deliberate manual flag distinct from #44's auto-set 'unread' marker. Use this to mark items that need to be actively discussed or reviewed in the next session.",
    {
      idOrTitle: z.string().describe("Quest id, exact title, or a substring of the title"),
      attention: z.boolean().describe("true to flag for attention, false to clear it"),
    },
    async ({ idOrTitle, attention }) => {
      const { result } = await mutateState(async (state) => {
        const outcome = setAttention(state, idOrTitle, attention);
        if (!outcome.error) {
          touchQuestAncestor(state, outcome.quest);
        }
        return outcome;
      });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.quest, null, 2) }] };
    },
  );

  server.tool(
    "confirm_completion",
    "Close out a mission/quest that's readyToClose (all its children are done), or a plain leaf item with no children. This is the only way to mark a parent 'done' -- call it only once both Claude and the user agree there's nothing left to add.",
    { idOrTitle: z.string().describe("Quest id, exact title, or a substring of the title") },
    async ({ idOrTitle }) => {
      const { result } = await mutateState(async (state) => {
        const outcome = confirmCompletion(state, idOrTitle);
        if (!outcome.error) {
          touchQuestAncestor(state, outcome.quest);
        }
        return outcome;
      });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.quest, null, 2) }] };
    },
  );

  server.tool(
    "promote",
    "Level a Task up to a Mission, or a Mission up to a Quest, in place (it becomes a sibling of its former parent under the same grandparent, or top-level if promoted all the way to Quest). Fails if the item has children -- promote or transfer them first.",
    { idOrTitle: z.string().describe("Quest id, exact title, or a substring of the title") },
    async ({ idOrTitle }) => {
      const { result } = await mutateState(async (state) => {
        const outcome = promoteQuest(state, idOrTitle);
        if (!outcome.error) {
          touchQuestAncestor(state, outcome.quest);
        }
        return outcome;
      });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.quest, null, 2) }] };
    },
  );

  server.tool(
    "recruit",
    "Bring an existing top-level Quest in as a Mission under another Quest, or an existing top-level Mission in as a Task under another Mission. Only works on something both parentless and childless -- use transfer instead if it already has a parent, and promote/reparent its children first if it has any. Pass an array to recruit several items under the same newParentIdOrTitle in one call (#24) -- each is attempted independently in a single save, so one failure doesn't block the rest; the response is a per-item array instead of a single result.",
    {
      idOrTitle: z
        .union([z.string(), z.array(z.string())])
        .describe("The top-level Quest or Mission to recruit -- or an array of several to recruit under the same newParentIdOrTitle at once"),
      newParentIdOrTitle: z.string().describe("The Quest (if recruiting a Quest) or Mission (if recruiting a Mission) to recruit it under"),
    },
    async ({ idOrTitle, newParentIdOrTitle }) => runBatch(recruitQuest, idOrTitle, newParentIdOrTitle),
  );

  server.tool(
    "transfer",
    "Move a Mission to a different Quest, or a Task to a different Mission -- same level, new parent. A Task may only transfer to a Mission under its current Quest; cross-Quest Task moves aren't allowed. Pass an array to move several items to the same newParentIdOrTitle in one call (#24) -- each is attempted independently in a single save, so one failure doesn't block the rest; the response is a per-item array instead of a single result.",
    {
      idOrTitle: z.union([z.string(), z.array(z.string())]).describe("The Mission or Task to move -- or an array of several to move to the same newParentIdOrTitle at once"),
      newParentIdOrTitle: z.string().describe("The new parent -- a Quest (for a Mission) or a Mission (for a Task)"),
    },
    async ({ idOrTitle, newParentIdOrTitle }) => runBatch(transferQuest, idOrTitle, newParentIdOrTitle),
  );

  server.tool(
    "delete_quest",
    "Permanently delete a quest/mission/task by id or (partial, case-insensitive) title match. Refuses if it has children unless cascade is set, since orphaned children would break the log -- pass cascade:true to remove the whole subtree at once.",
    {
      idOrTitle: z.string().describe("Quest id, exact title, or a substring of the title"),
      cascade: z.boolean().optional().describe("If true, also delete every descendant. Defaults to false (refuse when children exist)."),
    },
    async ({ idOrTitle, cascade }) => {
      const { result } = await mutateState(async (state) => {
        const outcome = deleteQuest(state, idOrTitle, { cascade });
        if (!outcome.error) {
          touchQuestAncestor(state, outcome.quest);
        }
        return outcome;
      });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "move",
    "Move an item -- and its whole subtree, whatever shape it is -- to become a child of a new parent, regardless of its current level, parent, or children. The general-purpose fix promote/recruit/transfer don't cover between them: recruit needs the item childless+parentless, transfer keeps the same level, promote never reparents. The moved item's new level is derived automatically from the new parent's level (one tier down); every descendant shifts by the same number of tiers to keep the subtree's shape. Omit newParentIdOrTitle to move it to top-level as a Quest. Only fails if the shift would push some descendant past Task -- promote/reparent that part first. Pass an array to move several items under the same newParentIdOrTitle in one call (#109) -- each is attempted independently in a single save, so one failure doesn't block the rest; the response is a per-item array instead of a single result.",
    {
      idOrTitle: z
        .union([z.string(), z.array(z.string())])
        .describe("Quest id, exact title, or a substring of the title -- the subtree root to move, or an array of several to move under the same newParentIdOrTitle at once"),
      newParentIdOrTitle: z
        .string()
        .optional()
        .describe("New parent's id, exact title, or a title substring. Omit to move the item(s) to top-level as a Quest."),
    },
    async ({ idOrTitle, newParentIdOrTitle }) => runBatch(moveQuest, idOrTitle, newParentIdOrTitle),
  );

  server.tool(
    "rename_quest",
    "Retitle an existing quest/mission/task in place, independent of any level change (#24). promote/recruit/move keep a title verbatim when leveling or reparenting something -- use this to fix a title first, e.g. before promoting a mission into an umbrella quest whose current title doesn't read as one.",
    {
      idOrTitle: z.string().describe("Quest id, exact title, or a substring of the title"),
      newTitle: z.string().describe("New title text, replacing the existing title entirely"),
    },
    async ({ idOrTitle, newTitle }) => {
      const { result } = await mutateState(async (state) => {
        const outcome = renameQuest(state, idOrTitle, newTitle);
        if (!outcome.error) {
          touchQuestAncestor(state, outcome.quest);
        }
        return outcome;
      });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.quest, null, 2) }] };
    },
  );

  server.tool(
    "set_designation",
    "Set the quest log's Designation/name shown in the header (#33). The browser field only allows a one-time initial entry and then locks itself read-only -- use this tool to change it after that.",
    { name: z.string().describe("New designation/name text") },
    async ({ name }) => {
      const { result } = await mutateState(async (state) => {
        return setDesignation(state, name);
      });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: `Designation set to "${result.designation}"` }] };
    },
  );

  server.tool(
    "update_quest_notes",
    "Replace an existing quest's notes text by id or (partial, case-insensitive) title match. Use this to fix stale/incorrect notes in place, e.g. after a status change that left old notes behind.",
    {
      idOrTitle: z.string().describe("Quest id, exact title, or a substring of the title"),
      notes: z.string().describe("New notes text, replacing the existing notes entirely"),
    },
    async ({ idOrTitle, notes }) => {
      // Write-layer guard: reject dangerous note content (#57)
      const noteValidation = validateNoteContent(notes);
      if (noteValidation) {
        return { content: [{ type: "text", text: noteValidation }], isError: true };
      }

      const { result } = await mutateState(async (state) => {
        const resolved = resolveOne(state, idOrTitle);
        if (resolved.error) return resolved;
        resolved.quest.notes = notes;
        touchQuestAncestor(state, resolved.quest);
        return resolved;
      });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.quest, null, 2) }] };
    },
  );

  server.tool(
    "add_log_entry",
    "Append an entry to the quest log's mission log for a given day (defaults to today).",
    {
      entry: z.string().describe("One line describing what happened"),
      date: z.string().optional().describe("YYYY-MM-DD, defaults to today"),
    },
    async ({ entry, date }) => {
      // Write-layer guard: reject dangerous log content (#57)
      const entryValidation = validateNoteContent(entry);
      if (entryValidation) {
        return { content: [{ type: "text", text: entryValidation }], isError: true };
      }

      const day = date ?? todayISO();
      await mutateState(async (state) => {
        let logDay = state.log.find((d) => d.date === day);
        if (!logDay) {
          logDay = { date: day, entries: [] };
          state.log.unshift(logDay);
        }
        logDay.entries.push(entry);
      });
      return { content: [{ type: "text", text: `Logged under ${day}: ${entry}` }] };
    },
  );

  server.tool("get_full_state", "Get the quest log's complete raw state (all quests and the full mission log).", {}, async () => {
    const state = await readState();

    // Compute the most-neglected (longest-untouched) top-level Quest
    const topLevelQuests = state.quests.filter((q) => q.level === "quest" && !q.parentId);
    let mostNeglectedQuest = null;
    if (topLevelQuests.length > 0) {
      // Sort by lastTouchedAt, treating missing as earliest (time 0)
      const sorted = [...topLevelQuests].sort((a, b) => {
        const aTime = a.lastTouchedAt ? new Date(a.lastTouchedAt).getTime() : 0;
        const bTime = b.lastTouchedAt ? new Date(b.lastTouchedAt).getTime() : 0;
        return aTime - bTime;
      });
      const oldest = sorted[0];
      mostNeglectedQuest = {
        id: oldest.id,
        title: oldest.title,
        lastTouchedAt: oldest.lastTouchedAt || null,
      };
    }

    const stateWithMostNeglected = { ...state, mostNeglectedQuest };
    return { content: withMaintenanceBanner(state, withAttentionInfo(state, [{ type: "text", text: JSON.stringify(stateWithMostNeglected, null, 2) }])) };
  });

  server.tool(
    "get_batch_status",
    "#64: status of a serialized multi-issue batch run, tracked as a Mission (or Quest) whose children are the batch's items in run order. Returns the batch item and its children ordered by createdAt (the order they were added while planning the run -- add_idea's repo/issueNumber params let each child link directly to the GitHub issue it tracks), plus a computed one-line summary ('3 of 6 done, currently on #44') so a session resuming a batch -- or the user checking in -- doesn't have to re-read prose notes to see where it stands. Doesn't require anything special about how the batch was created; any Mission/Quest with children works, repo/issueNumber are optional per child.",
    {
      idOrTitle: z.string().describe("The batch's own quest/mission id, exact title, or a substring of the title"),
    },
    async ({ idOrTitle }) => {
      const state = await readState();
      const resolved = resolveOne(state, idOrTitle);
      if (resolved.error) return { content: [{ type: "text", text: resolved.error }], isError: true };
      const batch = resolved.quest;
      const items = state.quests
        .filter((q) => q.parentId === batch.id)
        .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
      const done = items.filter((q) => q.status === "done").length;
      const current = items.find((q) => q.status !== "done");
      const summary = items.length === 0
        ? `${batch.title}: no items yet`
        : done === items.length
          ? `${batch.title}: ${done} of ${items.length} done -- batch complete`
          : `${batch.title}: ${done} of ${items.length} done -- currently on "${current.title}"${current.status === "progress" ? " (in progress)" : current.blocked ? " (blocked)" : ""}`;
      const result = {
        batch: { id: batch.id, title: batch.title, status: batch.status, notes: batch.notes },
        items: items.map((q) => ({
          id: q.id,
          title: q.title,
          status: q.status,
          blocked: q.blocked ?? false,
          repo: q.repo ?? null,
          issueNumber: q.issueNumber ?? null,
        })),
        summary,
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "set_maintenance",
    "Flag (or clear) an in-progress/upcoming redeploy so any already-open session gets a heads-up on its next call instead of just hitting a raw stale-session error. Call this before restarting the quest-log container, and call it again with active:false once the restart is confirmed healthy.",
    {
      active: z.boolean().describe("true to flag maintenance starting now, false to clear it"),
      note: z.string().optional().describe('Free-text note shown alongside the flag, e.g. "redeploying, back in ~5 min"'),
    },
    async ({ active, note }) => {
      const { result } = await mutateState(async (state) => {
        return setMaintenance(state, { active, note });
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "set_auto_log",
    "Toggle the machine-agnostic flag the checked-in UserPromptSubmit hook (.claude/hooks/) reads before reminding an active session to log a new ask into quest-log. Stored on shared state, not a local file, so flipping it from any one machine takes effect on every machine's hook immediately -- no per-machine setup.",
    {
      enabled: z.boolean().describe("true to have the hook remind sessions to log new asks, false to silence it"),
    },
    async ({ enabled }) => {
      const { result } = await mutateState(async (state) => {
        return setAutoLog(state, { enabled });
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "set_settings_mode",
    "Show (or hide) per-theme dev/tuning controls in the UI -- currently Raccoon Manor's power-cut darkness/glow/HUD-boost sliders. There's no in-page toggle by design: this MCP call is the only way to flip it, the same 'ask Claude, no code change needed' pattern as set_designation, so the owner can turn it on to tweak something and off again from any machine without a redeploy.",
    {
      enabled: z.boolean().describe("true to reveal settings-mode controls, false to hide them"),
    },
    async ({ enabled }) => {
      const { result } = await mutateState(async (state) => {
        return setSettingsMode(state, { enabled });
      });
      return { content: [{ type: "text", text: JSON.stringify({ settingsMode: result }, null, 2) }] };
    },
  );

  server.tool(
    "set_pro_mode",
    "Enable (or disable) pro-mode features like ticket tracking. A live toggle -- also flippable directly in the settings panel.",
    {
      enabled: z.boolean().describe("true to enable pro-mode features, false to disable them"),
    },
    async ({ enabled }) => {
      const { result } = await mutateState(async (state) => {
        return setProMode(state, { enabled });
      });
      return { content: [{ type: "text", text: JSON.stringify({ proMode: result }, null, 2) }] };
    },
  );

  server.tool(
    "log_ticket_touch",
    "Log a Halo ticket that was worked on, optionally noting whether it was closed with Claude's help. Not a source of truth for ticket status -- Halo is; this is just a record of how Claude helped.",
    {
      ticketId: z.string().describe("Halo ticket number/id"),
      client: z.string().describe("Client name the ticket belongs to"),
      url: z.string().describe("Direct link to the ticket in Halo"),
      note: z.string().describe("Short note on what was done"),
      closedWithHelp: z.boolean().optional().describe("Whether Claude helped close this ticket -- defaults to false"),
      questIdOrTitle: z.string().optional().describe("A quest/mission/task this ticket relates to, if any -- also attaches the ticket to it"),
    },
    async ({ ticketId, client, url, note, closedWithHelp, questIdOrTitle }) => {
      const { result } = await mutateState(async (state) => {
        if (!getProMode(state)) return { error: "Pro mode is not enabled." };
        let questId;
        if (questIdOrTitle) {
          const resolved = resolveOne(state, questIdOrTitle);
          if (resolved.error) return resolved;
          questId = resolved.quest.id;
        }
        const record = appendTicketTouch(state, { ticketId, client, url, note, closedWithHelp, questId });
        return { record };
      });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.record, null, 2) }] };
    },
  );

  server.tool(
    "log_ticket_view",
    "Log that a Halo ticket was viewed (read-only look, no work done). Lightweight -- counted only, no record kept of which ticket.",
    { ticketId: z.string().optional().describe("Accepted for caller convenience but not stored -- viewed events are count-only") },
    async () => {
      await mutateState(async (state) => {
        if (!getProMode(state)) return;
        appendTicketView(state);
      });
      return { content: [{ type: "text", text: "Logged a ticket view." }] };
    },
  );

  server.tool(
    "add_halo_ticket",
    "Attach a Halo ticket reference to an existing quest/mission/task, without logging it as work done (see log_ticket_touch for that).",
    {
      idOrTitle: z.string().describe("Quest id, exact title, or a substring of the title"),
      ticketId: z.string().describe("Halo ticket number/id"),
      client: z.string().describe("Client name the ticket belongs to"),
      url: z.string().describe("Direct link to the ticket in Halo"),
    },
    async ({ idOrTitle, ticketId, client, url }) => {
      const { result } = await mutateState(async (state) => {
        if (!getProMode(state)) return { error: "Pro mode is not enabled." };
        const resolved = resolveOne(state, idOrTitle);
        if (resolved.error) return resolved;
        attachHaloTicket(state, resolved.quest.id, { ticketId, client, url });
        return { quest: state.quests.find((q) => q.id === resolved.quest.id) };
      });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.quest, null, 2) }] };
    },
  );

  return server;
}

export function attachMcp(app, options = {}) {
  const transports = {};

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    let transport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      await createServer(options).connect(transport);
    } else if (sessionId) {
      // Session id doesn't match anything we hold in memory -- almost always
      // because the process restarted (redeploy/crash) and lost the map, not
      // because the client sent a bogus id. Per the streamable-HTTP transport
      // spec, an unrecognized session id gets 404, not 400: a compliant
      // client treats 404 as "reinitialize", so this turns a permanently
      // wedged session into a transparent reconnect instead of every
      // subsequent call failing with the same opaque error forever.
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
      });
      return;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session and not an initialize request" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  const handleSessionRequest = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      res.status(404).send("Session not found");
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);
}
