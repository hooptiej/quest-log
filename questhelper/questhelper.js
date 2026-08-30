import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readState, mutateState, todayISO, slugify, findQuestCandidates, describeQuest } from "../state.js";

function ambiguousError(idOrTitle, matches) {
  return `Ambiguous match for "${idOrTitle}": ${matches.map(describeQuest).join(", ")}. Use the exact id instead.`;
}

function resolveOne(state, idOrTitle) {
  const matches = findQuestCandidates(state, idOrTitle);
  if (matches.length === 0) return { error: `No quest found matching "${idOrTitle}"` };
  if (matches.length > 1) return { error: ambiguousError(idOrTitle, matches) };
  return { quest: matches[0] };
}

function createServer() {
  const server = new McpServer({ name: "questhelper", version: "1.0.0" });

  server.tool(
    "list_quests",
    "List quests from the quest log, optionally filtered by status (idea, progress, blocked, done).",
    { status: z.enum(["idea", "progress", "blocked", "done"]).optional().describe("Filter to just this status") },
    async ({ status }) => {
      const state = await readState();
      const quests = status ? state.quests.filter((q) => q.status === status) : state.quests;
      return { content: [{ type: "text", text: JSON.stringify(quests, null, 2) }] };
    },
  );

  server.tool(
    "add_idea",
    "Add a new idea/project/task to the quest log's idea board.",
    {
      title: z.string().describe("Short title for the idea"),
      notes: z.string().optional().describe("Optional description/context"),
      status: z.enum(["idea", "progress", "blocked", "done"]).optional().describe("Defaults to 'idea'"),
    },
    async ({ title, notes, status }) => {
      const { result: quest } = await mutateState(async (state) => {
        const q = { id: slugify(title), title, status: status ?? "idea", notes: notes ?? "" };
        if (q.status === "done") q.date = todayISO();
        state.quests.push(q);
        return q;
      });
      return { content: [{ type: "text", text: JSON.stringify(quest, null, 2) }] };
    },
  );

  server.tool(
    "set_quest_status",
    "Update an existing quest's status by id or (partial, case-insensitive) title match.",
    {
      idOrTitle: z.string().describe("Quest id, exact title, or a substring of the title"),
      status: z.enum(["idea", "progress", "blocked", "done"]),
    },
    async ({ idOrTitle, status }) => {
      const { result } = await mutateState(async (state) => {
        const resolved = resolveOne(state, idOrTitle);
        if (resolved.error) return resolved;
        const quest = resolved.quest;
        if (status === "done" && quest.status !== "done") {
          quest._prevStatus = quest.status;
          quest.date = quest.date ?? todayISO();
        }
        quest.status = status;
        return { quest };
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
      });
      return { content: [{ type: "text", text: `Logged under ${day}: ${entry}` }] };
    },
  );

  server.tool("get_full_state", "Get the quest log's complete raw state (all quests and the full mission log).", {}, async () => {
    const state = await readState();
    return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
  });

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
      res.status(400).send("Unknown or missing session");
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);
}
