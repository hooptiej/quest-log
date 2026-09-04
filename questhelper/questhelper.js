import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { QUEST_LOG_CSS } from "../app/css.js";
import {
  readState,
  mutateState,
  todayISO,
  nowISO,
  slugify,
  describeQuest,
  bumpArtifactChangeCounter,
  artifactNeedsUpdate,
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
  setBlocked,
  setArchived,
  setAttention,
  touchQuestAncestor,
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

// Prepended to read tools' responses when the mirrored artifact is stale,
// so a session is notified on next call instead of silently continuing to
// work with an out-of-date mirror. Used alongside withMaintenanceBanner()
// -- maintenance banner appears first if both are flagged.
function withArtifactStalenessInfo(state, content) {
  if (!artifactNeedsUpdate(state)) return content;
  const a = state._artifact ?? { changesSince: 0 };
  return [{ type: "text", text: `⚠️ Artifact mirror is stale (${a.changesSince} changes since last publish) — call record_artifact_update(url) after republishing` }, ...content];
}

// Prepended to read tools' responses when any items have the attention flag set,
// so a session is nudged to actively follow up on those items. Follows the
// pattern of withMaintenanceBanner and withArtifactStalenessInfo.
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
    if (outcomes.some((o) => !o.error)) bumpArtifactChangeCounter(state, { mainQuest: true });
    return outcomes;
  });
  if (!Array.isArray(idOrTitleOrList)) {
    const [only] = result;
    if (only.error) return { content: [{ type: "text", text: only.error }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(only.quest, null, 2) }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

function createServer(options = {}) {
  const env = options.env ?? "prod";
  const serverName = env === "dev" ? "questhelper-dev" : "questhelper";
  const server = new McpServer({ name: serverName, version: "1.0.0" });

  server.tool(
    "list_quests",
    "List quests from the quest log, optionally filtered by status and/or level (quest/mission/task). Each quest includes a createdAt timestamp for tracking when it was created. By default, archived items are excluded; pass archived:true to see only archived items or archived:false to see only non-archived items.",
    {
      status: z.enum(["idea", "progress", "done"]).optional().describe("Filter to just this status"),
      level: z.enum(LEVELS).optional().describe("Filter to just this level"),
      blocked: z.boolean().optional().describe("Filter to only blocked (true) or only unblocked (false) quests"),
      archived: z.boolean().optional().describe("Filter to only archived (true) or only non-archived (false) quests. Default (undefined) excludes archived items from results."),
      attention: z.boolean().optional().describe("Filter to only attention-flagged (true) or only non-flagged (false) quests"),
      tree: z.boolean().optional().describe("Return nested (quest -> missions -> tasks) instead of a flat list"),
      sortByCreatedAtDesc: z.boolean().optional().describe("Sort by createdAt descending (newest first). Only applies to flat list (tree: false)"),
    },
    async ({ status, level, blocked, archived, attention, tree, sortByCreatedAtDesc }) => {
      const state = await readState();
      let quests = state.quests;
      if (status) quests = quests.filter((q) => q.status === status);
      if (level) quests = quests.filter((q) => q.level === level);
      if (blocked !== undefined) quests = quests.filter((q) => !!q.blocked === blocked);
      if (attention !== undefined) quests = quests.filter((q) => !!q.attention === attention);
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
      if (!tree) return { content: withMaintenanceBanner(state, withArtifactStalenessInfo(state, withAttentionInfo(state, [{ type: "text", text: JSON.stringify(quests, null, 2) }]))) };

      const byParent = new Map();
      for (const q of quests) {
        const key = q.parentId ?? null;
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(q);
      }
      const attachChildren = (q) => ({ ...q, children: (byParent.get(q.id) ?? []).map(attachChildren) });
      const roots = (byParent.get(null) ?? []).map(attachChildren);
      return { content: withMaintenanceBanner(state, withArtifactStalenessInfo(state, withAttentionInfo(state, [{ type: "text", text: JSON.stringify(roots, null, 2) }]))) };
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
        bumpArtifactChangeCounter(state, { mainQuest: true });
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
        bumpArtifactChangeCounter(state, { mainQuest: true });
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
          bumpArtifactChangeCounter(state, { mainQuest: false });
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
          bumpArtifactChangeCounter(state, { mainQuest: false });
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
          bumpArtifactChangeCounter(state, { mainQuest: false });
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
          bumpArtifactChangeCounter(state, { mainQuest: true });
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
          bumpArtifactChangeCounter(state, { mainQuest: true });
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
          bumpArtifactChangeCounter(state, { mainQuest: true });
        }
        return outcome;
      });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "move",
    "Move an item -- and its whole subtree, whatever shape it is -- to become a child of a new parent, regardless of its current level, parent, or children. The general-purpose fix promote/recruit/transfer don't cover between them: recruit needs the item childless+parentless, transfer keeps the same level, promote never reparents. The moved item's new level is derived automatically from the new parent's level (one tier down); every descendant shifts by the same number of tiers to keep the subtree's shape. Omit newParentIdOrTitle to move it to top-level as a Quest. Only fails if the shift would push some descendant past Task -- promote/reparent that part first.",
    {
      idOrTitle: z.string().describe("Quest id, exact title, or a substring of the title -- the subtree root to move"),
      newParentIdOrTitle: z
        .string()
        .optional()
        .describe("New parent's id, exact title, or a title substring. Omit to move the item to top-level as a Quest."),
    },
    async ({ idOrTitle, newParentIdOrTitle }) => {
      const { result } = await mutateState(async (state) => {
        const outcome = moveQuest(state, idOrTitle, newParentIdOrTitle);
        if (!outcome.error) {
          touchQuestAncestor(state, outcome.quest);
          bumpArtifactChangeCounter(state, { mainQuest: true });
        }
        return outcome;
      });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
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
          bumpArtifactChangeCounter(state, { mainQuest: true });
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
        bumpArtifactChangeCounter(state, { mainQuest: false });
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
        bumpArtifactChangeCounter(state, { mainQuest: false });
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
    return { content: withMaintenanceBanner(state, withArtifactStalenessInfo(state, withAttentionInfo(state, [{ type: "text", text: JSON.stringify(stateWithMostNeglected, null, 2) }]))) };
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
    "get_artifact_status",
    "Check whether the mirrored claude.ai Artifact of this quest log is due for a republish, and get the current full state to build it from. Call this at the start of every session that uses quest-log, and again after any write that might have flipped needsUpdate.",
    {},
    async () => {
      const state = await readState();
      const a = state._artifact ?? { url: null, changesSince: 0, mainQuestChanged: false };
      return {
        content: withMaintenanceBanner(state, withArtifactStalenessInfo(state, [
          {
            type: "text",
            text: JSON.stringify(
              {
                needsUpdate: artifactNeedsUpdate(state),
                url: a.url,
                mainQuestChanged: a.mainQuestChanged,
                changesSince: a.changesSince,
                state,
              },
              null,
              2,
            ),
          },
        ])),
      };
    },
  );

  server.tool(
    "record_artifact_update",
    "Call this right after publishing or updating the mirrored claude.ai Artifact, to reset the change counter. Always pass the artifact's URL (same one every time -- this is a single shared artifact, not one per session).",
    { url: z.string().describe("The claude.ai artifact URL") },
    async ({ url }) => {
      await mutateState(async (state) => {
        state._artifact = { url, changesSince: 0, mainQuestChanged: false };
      });
      return { content: [{ type: "text", text: `Recorded artifact sync at ${url}` }] };
    },
  );

  server.tool(
    "get_mirror_template",
    "Fetch the CSS and read-only render logic for building a static mirror of the quest log in claude.ai. Used alongside get_full_state() and get_artifact_status() to assemble a complete artifact mirror.",
    {},
    async () => {
      const renderCode = `// Read-only render logic extracted from app.js for mirror template
// No event listeners, no persist() calls, no STATE mutations
(function() {
  var STATUS_META = {
    progress: { tag: "ACTIVE" },
    idea: { tag: "IDEA" },
    done: { tag: "DONE" }
  };
  var LEVEL_UP = { task: "mission", mission: "quest" };
  var NOTES_ALLOWED_ATTRS = { A: ["href", "target"] };

  function truncate(s, max) {
    if (s.length <= max) return s;
    return s.slice(0, max).replace(/\\s+\\S*$/, "") + "…";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;", "'": "&#39;" }[c];
    });
  }

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
            if (!/^(https?:|mailto:|\\/)/.test(href)) child.removeAttribute("href");
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

  function notesPlainText(html) {
    var doc = new DOMParser().parseFromString("<div>" + String(html == null ? "" : html) + "</div>", "text/html");
    return (doc.body.textContent || "").replace(/\\s+/g, " ").trim();
  }

  function childLevelFor(level) {
    if (level === "quest") return "mission";
    if (level === "mission") return "task";
    return null;
  }

  function notesToggleButton(collapsed, title) {
    return '<button type="button" class="notes-toggle" data-action="toggle-notes" aria-expanded="' + (!collapsed) + '" aria-label="Toggle notes for ' + escapeHtml(title) + '">' + (collapsed ? "▸ more" : "▾ less") + '</button>';
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

  function childCountLabel(q, children) {
    var noun = q.level === "quest" ? "mission" : "task";
    var doneCount = children.filter(function (c) { return c.status === "done"; }).length;
    return children.length + " " + noun + (children.length === 1 ? "" : "s") + (doneCount > 0 ? ", " + doneCount + " done" : "");
  }

  function questRow(q) {
    var checked = q.status === "done";
    var childLevel = childLevelFor(q.level);
    var canPromote = q.level !== "quest";
    return (
      '<div class="quest' + (checked ? " is-done" : "") + blockedClass(q) + '" data-id="' + escapeHtml(q.id) + '">' +
        '<button type="button" class="quest-check" data-action="toggle-done" data-id="' + escapeHtml(q.id) + '" aria-pressed="' + checked + '" aria-label="Mark ' + escapeHtml(q.title) + (checked ? ' not done' : ' done') + '">' +
          (checked ? "[x]" : "[ ]") +
        '</button>' +
        '<div class="quest-title-row">' +
          '<span class="quest-title">' + escapeHtml(q.title) + '</span>' +
          blockedBadge(q) +
        '</div>' +
        (q.notes
          ? '<div class="quest-notes-teaser">' + notesTeaser(q.notes) + ' ' + notesToggleButton(true, q.title) + '</div>' +
            '<div class="quest-notes collapsed">' + sanitizeNotes(q.notes) + (q.date ? ' <span style="opacity:0.6">(' + q.date + ')</span>' : '') + ' ' + notesToggleButton(false, q.title) + '</div>'
          : '<div class="quest-notes"></div>') +
      '</div>'
    );
  }

  function isTreeItem(q, parentIds) {
    return q.level === "quest" || !!q.parentId || parentIds.has(q.id);
  }

  function treeNode(q, byParent) {
    var children = byParent[q.id] || [];
    var checked = q.status === "done";
    var hasChildren = children.length > 0;
    var meta = STATUS_META[q.status] || { tag: "UNKNOWN" };
    var childLevel = childLevelFor(q.level);
    var canPromote = q.level !== "quest" && !hasChildren;
    var expanded = false;
    return (
      '<div class="tree-node' + (checked ? " is-done" : "") + blockedClass(q) + '" data-id="' + escapeHtml(q.id) + '">' +
        '<div class="tree-row">' +
          '<span class="tree-title-group">' +
            (hasChildren
              ? '<button type="button" class="tree-toggle" data-action="toggle-tree" aria-expanded="' + expanded + '" aria-label="Toggle ' + escapeHtml(q.title) + '">' + (expanded ? "▾" : "▸") + '</button>' +
                '<span class="child-count' + (expanded ? " collapsed" : "") + '">(' + escapeHtml(childCountLabel(q, children)) + ')</span>'
              : '<span class="tree-toggle-spacer"></span>') +
            '<span class="tree-title">' + escapeHtml(q.title) + '</span>' +
            blockedBadge(q) +
          '</span>' +
          '<span class="tree-actions">' +
            '<span class="tree-meta">' + escapeHtml(q.level) + '</span>' +
            (hasChildren && q.readyToClose ? '<span class="ready-badge">Ready to close</span>' : '<span class="quest-tag">' + meta.tag + '</span>') +
          '</span>' +
        '</div>' +
        (q.notes
          ? '<div class="tree-notes-teaser">' + notesTeaser(q.notes) + ' ' + notesToggleButton(true, q.title) + '</div>' +
            '<div class="tree-notes collapsed">' + sanitizeNotes(q.notes) + (q.date ? ' <span style="opacity:0.6">(' + q.date + ')</span>' : '') + ' ' + notesToggleButton(false, q.title) + '</div>'
          : '') +
        (hasChildren ? '<div class="tree-children' + (expanded ? "" : " collapsed") + '">' + children.map(function (c) { return treeNode(c, byParent); }).join("") + '</div>' : '') +
      '</div>'
    );
  }

  function renderQuestTree(state, parentIds) {
    var byParent = {};
    state.quests.forEach(function (q) {
      if (!q.parentId) return;
      (byParent[q.parentId] = byParent[q.parentId] || []).push(q);
    });
    var roots = state.quests.filter(function (q) {
      return !q.parentId && (q.level === "quest" || parentIds.has(q.id));
    });
    return roots.length
      ? roots.map(function (q) { return treeNode(q, byParent); }).join("")
      : '<div class="empty-row">// no Quests yet</div>';
  }

  function render(state) {
    var parentIds = new Set();
    state.quests.forEach(function (q) { if (q.parentId) parentIds.add(q.parentId); });

    var groups = { progress: [], idea: [], done: [] };
    state.quests.forEach(function (q) {
      if (isTreeItem(q, parentIds)) return;
      if (!groups[q.status]) return;
      groups[q.status].push(q);
    });

    var questTreeHtml = renderQuestTree(state, parentIds);
    var ideaHtml = groups.idea.length
      ? groups.idea.map(questRow).join("")
      : '<div class="empty-row">// none</div>';

    var total = state.quests.length;
    var doneCount = groups.done.length;
    var pct = total ? Math.round((doneCount / total) * 100) : 0;
    var blockedCount = state.quests.filter(function (q) { return !!q.blocked; }).length;

    return {
      questTree: questTreeHtml,
      idea: ideaHtml,
      progress: groups.progress.length,
      doneCount: doneCount,
      blockedCount: blockedCount,
      total: total,
      pct: pct
    };
  }

  return { render: render };
})();`;

      const version = "1.0.0";
      const renderFunctions = [
        "render(state)",
        "renderQuestTree(state, parentIds)",
        "treeNode(q, byParent)",
        "questRow(q)",
        "childCountLabel(q, children)",
        "notesTeaser(notes)",
        "blockedBadge(q)",
        "blockedClass(q)",
        "escapeHtml(s)",
        "sanitizeNotes(html)"
      ];

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                css: QUEST_LOG_CSS,
                renderCode: renderCode,
                renderFunctions: renderFunctions,
                version: version
              },
              null,
              2
            )
          }
        ]
      };
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
