import "dotenv/config";
import express from "express";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readState, mutateState, validateState, nowISO, setProMode } from "../state.js";
import { attachMcp } from "../questhelper/questhelper.js";
import { renderIndexHtml } from "./render.js";
import pkg from "../package.json" with { type: "json" };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..");
const QUEST_LOG_ENV = process.env.QUEST_LOG_ENV ?? "prod";
const DEFAULT_PORT = QUEST_LOG_ENV === "dev" ? 4243 : 4242;
const DEFAULT_DATA_PATH = QUEST_LOG_ENV === "dev" ? join(ROOT_DIR, "data", "state.dev.json") : join(ROOT_DIR, "data", "state.json");
const DATA_PATH = process.env.DATA_PATH ?? DEFAULT_DATA_PATH;
const TEMPLATE_PATH = join(__dirname, "template.html");
const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const DISABLE_TLS = process.env.DISABLE_TLS === "1";
const CERT_PATH = process.env.CERT_PATH ?? join(ROOT_DIR, "certs", "cert.pem");
const KEY_PATH = process.env.KEY_PATH ?? join(ROOT_DIR, "certs", "key.pem");
const WRITE_TOKEN_PATH = process.env.WRITE_TOKEN_PATH ?? join(dirname(DATA_PATH), "write-token");

// POST /api/state previously had no auth at all -- anything that could
// reach the port could overwrite state. There's no login system for this
// LAN-only tool, so instead of building one we gate writes on a shared
// secret the server generates once, persists next to state.json, and
// hands to the browser only via the server-rendered page (see "/" below).
function loadOrCreateWriteToken() {
  if (process.env.WRITE_TOKEN) return process.env.WRITE_TOKEN;
  if (existsSync(WRITE_TOKEN_PATH)) return readFileSync(WRITE_TOKEN_PATH, "utf8").trim();
  const token = randomBytes(32).toString("hex");
  writeFileSync(WRITE_TOKEN_PATH, token, { mode: 0o600 });
  return token;
}
const WRITE_TOKEN = loadOrCreateWriteToken();

const app = express();
// The client POSTs the entire state document on every mutation (see
// render/full-state-POST notes below), so this limit bounds *total*
// accumulated state size, not any single edit -- state.json crossed the
// old 256kb limit from ordinary organic growth (quest/mission notes, log
// entries) and every save started failing with PayloadTooLargeError.
app.use(express.json({ limit: "8mb" }));
// No caching, anywhere -- this is a low-traffic personal LAN app, not a
// site where caching buys anything worth the cost. That cost showed up
// concretely during active theme work: express.static's default headers
// (ETag + ~Cache-Control: max-age=0) still leave room for a browser's own
// heuristics to serve a stale app.js on a plain reload while a hard
// refresh forces revalidation -- exactly the "hard refresh looks right,
// normal reload doesn't" symptom that cost real time to track down. The
// rendered "/" page is dynamic (reflects live state) and was never
// correct to cache regardless.
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use(express.static(join(__dirname, "public")));

app.get("/", async (_req, res, next) => {
  try {
    const [template, state] = await Promise.all([readFile(TEMPLATE_PATH, "utf8"), readState()]);
    const html = renderIndexHtml(template, state, WRITE_TOKEN, pkg.version, QUEST_LOG_ENV);
    res.type("html").send(html);
  } catch (err) {
    next(err);
  }
});

app.get("/api/state", async (_req, res, next) => {
  try {
    res.json(await readState());
  } catch (err) {
    next(err);
  }
});

class ConflictError extends Error {
  constructor(currentVersion) {
    super("state changed since you last loaded it");
    this.currentVersion = currentVersion;
  }
}

app.post("/api/state", async (req, res, next) => {
  try {
    if (req.get("x-write-token") !== WRITE_TOKEN) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const incoming = req.body;
    const validationError = validateState(incoming);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const expectedVersion = incoming._version;
    let version;
    try {
      // The version check happens inside the locked mutator so it's
      // atomic with the write -- checking beforehand would leave a gap
      // another writer could slip through.
      ({ version } = await mutateState(async (state) => {
        const currentVersion = state._version ?? 0;
        if (typeof expectedVersion === "number" && expectedVersion !== currentVersion) {
          throw new ConflictError(currentVersion);
        }
        // Ensure any new quests (ones coming from incoming that weren't in
        // the previous state) get a createdAt timestamp set if they don't have one
        const existingIds = new Set(state.quests.map((q) => q.id));
        state.quests = incoming.quests.map((q) => {
          // If this is a new quest (wasn't in state before) and doesn't have
          // createdAt, set it now
          if (!existingIds.has(q.id) && !q.createdAt) {
            return { ...q, createdAt: nowISO() };
          }
          return q;
        });
        state.log = incoming.log;
        // The one-time initial Designation entry (#33) rides along on this
        // same wholesale save -- everything after that first save goes
        // through the set_designation MCP tool instead, since the browser
        // field locks itself read-only once a name exists.
        if (typeof incoming.designation === "string" && incoming.designation.trim()) {
          state.designation = incoming.designation.trim();
        }
        // Pro Mode's settings-panel checkbox rides along on this same
        // wholesale save too -- same reasoning as designation above, just
        // without the one-time lock (it's a live, flippable switch).
        if (typeof incoming._proMode === "boolean") {
          setProMode(state, { enabled: incoming._proMode });
        }
      }));
    } catch (err) {
      if (err instanceof ConflictError) {
        return res.status(409).json({ error: "conflict: state changed since you last loaded it", currentVersion: err.currentVersion });
      }
      throw err;
    }
    res.status(200).json({ version });
  } catch (err) {
    next(err);
  }
});

attachMcp(app, { env: QUEST_LOG_ENV });

app.get("/health", (_req, res) => res.json({ status: "ok", version: pkg.version }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

if (!existsSync(DATA_PATH)) {
  console.error(`No state file at ${DATA_PATH}. Seed it before starting (see README).`);
  process.exit(1);
}

const LISTEN_HOST = process.env.LISTEN_HOST ?? "0.0.0.0";

if (!DISABLE_TLS && existsSync(CERT_PATH) && existsSync(KEY_PATH)) {
  const options = { cert: readFileSync(CERT_PATH), key: readFileSync(KEY_PATH) };
  createHttpsServer(options, app).listen(PORT, LISTEN_HOST, () => {
    console.log(`quest-log listening on ${LISTEN_HOST}:${PORT} (https, self-signed)`);
  });
} else {
  app.listen(PORT, LISTEN_HOST, () => {
    console.log(`quest-log listening on ${LISTEN_HOST}:${PORT} (http - no cert found at ${CERT_PATH})`);
  });
}
