// HTTPS-facing catalog API — Chrome extension talks HERE, never to MongoDB directly
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");

const URI = process.env.MONGODB_URI;
const DB = process.env.MONGODB_DB || "imdb_stream_finder";
const PORT = Number(process.env.PORT || 8787);
const CATALOG_TOKEN = process.env.CATALOG_TOKEN || ""; // optional bearer lock for extra security

if (!URI) {
  console.error("Missing MONGODB_URI");
  process.exit(1);
}

const app = express();
app.use(cors()); // extension fetch from chrome-extension:// origins
app.use(express.json());

let client;
let db;

function auth(req, res, next) {
  if (!CATALOG_TOKEN) return next(); // open read if no token configured
  const header = String(req.headers.authorization || "");
  const ok = header === `Bearer ${CATALOG_TOKEN}`;
  if (!ok) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// Shape expected by the extension remote sync (providers-catalog.json compatible)
app.get("/providers-catalog.json", auth, async (_req, res) => {
  try {
    const providers = await db
      .collection("providers")
      .find({ enabled: { $ne: false } })
      .project({ _id: 0 })
      .toArray();
    const meta = await db.collection("catalog_meta").findOne({ _id: "current" });
    res.json({
      version: meta?.version || "remote",
      updated: meta?.updated || new Date().toISOString().slice(0, 10),
      providers
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "catalog_unavailable" });
  }
});

async function start() {
  client = new MongoClient(URI);
  await client.connect();
  db = client.db(DB);
  app.listen(PORT, () => {
    console.log(`Catalog API on http://127.0.0.1:${PORT}/providers-catalog.json`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
