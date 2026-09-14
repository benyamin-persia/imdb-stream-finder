// One-time (or refresh) seed: load local catalog JSON into Atlas `providers`
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const URI = process.env.MONGODB_URI; // Atlas connection string — never ship in the Chrome extension
const DB = process.env.MONGODB_DB || "imdb_stream_finder";

async function main() {
  if (!URI) throw new Error("Missing MONGODB_URI in catalog-api/.env");
  const catalogPath = path.join(__dirname, "..", "private", "providers-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const providers = (catalog.providers || []).map((p) => ({
    ...p,
    enabled: p.enabled !== false
  }));

  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db(DB);
  const col = db.collection("providers");

  await col.deleteMany({}); // replace catalog cleanly on each seed
  if (providers.length) await col.insertMany(providers);

  await db.collection("catalog_meta").deleteMany({});
  await db.collection("catalog_meta").insertOne({
    _id: "current",
    version: catalog.version || new Date().toISOString().slice(0, 10),
    updated: catalog.updated || new Date().toISOString().slice(0, 10),
    providerCount: providers.length
  });

  console.log(`Seeded ${providers.length} providers into ${DB}.providers`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
