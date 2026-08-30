import "dotenv/config";
import express from "express";
import { createServer as createHttpsServer } from "node:https";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = process.env.DATA_PATH ?? join(__dirname, "data", "state.json");
const TEMPLATE_PATH = join(__dirname, "template.html");
const PORT = Number(process.env.PORT ?? 4242);
const CERT_PATH = process.env.CERT_PATH ?? join(__dirname, "certs", "cert.pem");
const KEY_PATH = process.env.KEY_PATH ?? join(__dirname, "certs", "key.pem");

async function readState() {
  const raw = await readFile(DATA_PATH, "utf8");
  return JSON.parse(raw);
}

async function writeState(state) {
  await writeFile(DATA_PATH, JSON.stringify(state, null, 2));
}

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

app.post("/api/state", async (req, res, next) => {
  try {
    const state = req.body;
    if (!state || !Array.isArray(state.quests) || !Array.isArray(state.log)) {
      return res.status(400).json({ error: "expected { quests: [], log: [] }" });
    }
    await writeState(state);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

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
