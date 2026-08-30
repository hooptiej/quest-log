import "dotenv/config";
import express from "express";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readState, mutateState, validateState } from "./state.js";
import { attachMcp } from "./mcp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = process.env.DATA_PATH ?? join(__dirname, "data", "state.json");
const TEMPLATE_PATH = join(__dirname, "template.html");
const PORT = Number(process.env.PORT ?? 4242);
const CERT_PATH = process.env.CERT_PATH ?? join(__dirname, "certs", "cert.pem");
const KEY_PATH = process.env.KEY_PATH ?? join(__dirname, "certs", "key.pem");

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(join(__dirname, "public")));

app.get("/", async (_req, res, next) => {
  try {
    const [template, state] = await Promise.all([readFile(TEMPLATE_PATH, "utf8"), readState()]);
    const html = template.replace("__STATE_JSON__", JSON.stringify(state));
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
        state.quests = incoming.quests;
        state.log = incoming.log;
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

attachMcp(app);

app.get("/health", (_req, res) => res.type("text/plain").send("ok"));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

if (!existsSync(DATA_PATH)) {
  console.error(`No state file at ${DATA_PATH}. Seed it before starting (see README).`);
  process.exit(1);
}

if (existsSync(CERT_PATH) && existsSync(KEY_PATH)) {
  const options = { cert: readFileSync(CERT_PATH), key: readFileSync(KEY_PATH) };
  createHttpsServer(options, app).listen(PORT, () => {
    console.log(`quest-log listening on :${PORT} (https, self-signed)`);
  });
} else {
  app.listen(PORT, () => {
    console.log(`quest-log listening on :${PORT} (http - no cert found at ${CERT_PATH})`);
  });
}
