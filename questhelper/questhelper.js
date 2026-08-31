import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  readState,
  mutateState,
  todayISO,
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
  getMaintenance,
  setMaintenance,
  setBlocked,
} from "../state.js";

const LEVELS = ["quest", "mission", "task"];

// Prepended to a read tool's response when maintenance is flagged, so a
// session sees the heads-up on whatever it happens to call next rather than
// needing to know to check a specific tool.
function withMaintenanceBanner(state, content) {
  const m = getMaintenance(state);
  if (!m.active) return content;
  const note = m.note ? `: ${m.note}` : "";
  return [{ type: "text", text: `⚠️ quest-log maintenance flagged since ${m.since}${note}` }, ...content];
}

function createServer() {
  const server = new McpServer({ name: "questhelper", version: "1.0.0" });

  server.tool(
    "list_quests",
    "List quests from the quest log, optionally filtered by status and/or level (quest/mission/task).",
    {
      status: z.enum(["idea", "progress", "done"]).optional().describe("Filter to just this status"),
      level: z.enum(LEVELS).optional().describe("Filter to just this level"),
      blocked: z.boolean().optional().describe("Filter to only blocked (true) or only unblocked (false) quests"),
      tree: z.boolean().optional().describe("Return nested (quest -> missions -> tasks) instead of a flat list"),
    },
    async ({ status, level, blocked, tree }) => {
      const state = await readState();
      let quests = state.quests;
      if (status) quests = quests.filter((q) => q.status === status);
      if (level) quests = quests.filter((q) => q.level === level);
      if (blocked !== undefined) quests = quests.filter((q) => !!q.blocked === blocked);
      if (!tree) return { content: withMaintenanceBanner(state, [{ type: "text", text: JSON.stringify(quests, null, 2) }]) };

      const byParent = new Map();
      for (const q of quests) {
        const key = q.parentId ?? null;
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(q);
      }
      const attachChildren = (q) => ({ ...q, children: (byParent.get(q.id) ?? []).map(attachChildren) });
      const roots = (byParent.get(null) ?? []).map(attachChildren);
      return { content: withMaintenanceBanner(state, [{ type: "text", text: JSON.stringify(roots, null, 2) }]) };
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
    },
    async ({ title, notes, status, level, parentIdOrTitle }) => {
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
        };
        if (q.status === "done") q.date = todayISO();
        state.quests.push(q);
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
        if (!outcome.error) bumpArtifactChangeCounter(state, { mainQuest: false });
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
        if (!outcome.error) bumpArtifactChangeCounter(state, { mainQuest: true });
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
        if (!outcome.error) bumpArtifactChangeCounter(state, { mainQuest: true });
        return outcome;
      });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.quest, null, 2) }] };
    },
  );

  server.tool(
    "recruit",
    "Bring an existing top-level Quest in as a Mission under another Quest, or an existing top-level Mission in as a Task under another Mission. Only works on something both parentless and childless -- use transfer instead if it already has a parent, and promote/reparent its children first if it has any.",
    {
      idOrTitle: z.string().describe("The top-level Quest or Mission to recruit"),
      newParentIdOrTitle: z.string().describe("The Quest (if recruiting a Quest) or Mission (if recruiting a Mission) to recruit it under"),
    },
    async ({ idOrTitle, newParentIdOrTitle }) => {
      const { result } = await mutateState(async (state) => {
        const outcome = recruitQuest(state, idOrTitle, newParentIdOrTitle);
        if (!outcome.error) bumpArtifactChangeCounter(state, { mainQuest: true });
        return outcome;
      });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.quest, null, 2) }] };
    },
  );

  server.tool(
    "transfer",
    "Move a Mission to a different Quest, or a Task to a different Mission -- same level, new parent. A Task may only transfer to a Mission under its current Quest; cross-Quest Task moves aren't allowed.",
    {
      idOrTitle: z.string().describe("The Mission or Task to move"),
      newParentIdOrTitle: z.string().describe("The new parent -- a Quest (for a Mission) or a Mission (for a Task)"),
    },
    async ({ idOrTitle, newParentIdOrTitle }) => {
      const { result } = await mutateState(async (state) => {
        const outcome = transferQuest(state, idOrTitle, newParentIdOrTitle);
        if (!outcome.error) bumpArtifactChangeCounter(state, { mainQuest: true });
        return outcome;
      });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.quest, null, 2) }] };
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
      const { result } = await mutateState(async (state) => {
        const resolved = resolveOne(state, idOrTitle);
        if (resolved.error) return resolved;
        resolved.quest.notes = notes;
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
    return { content: withMaintenanceBanner(state, [{ type: "text", text: JSON.stringify(state, null, 2) }]) };
  });

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
        content: withMaintenanceBanner(state, [
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
        ]),
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

  return server;
}

export function attachMcp(app) {
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
      await createServer().connect(transport);
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
