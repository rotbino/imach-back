#!/usr/bin/env node
/**
 * iMach — Database Backup (migration-safe)
 * ------------------------------------------------------------
 * Full dump of every collection in the MongoDB database given by
 * DATABASE_URL (or --uri). Output is EJSON (lossless: ObjectId,
 * Date, Decimal128, Binary all survive the round-trip) plus a
 * manifest with per-collection counts, SHA-256 checksums and index
 * definitions so `restore-db.mjs` can rebuild the database exactly.
 *
 * Usage:
 *   DATABASE_URL="mongodb+srv://..." node scripts/backup-db.mjs \
 *        --out backups/migration/2026-10-05
 *
 * Requires `mongodb` (already in imach-back devDependencies).
 */
import { MongoClient } from "mongodb";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const EJSON_NS = "mongodb";
let EJSON;
try {
  const m = await import(EJSON_NS);
  EJSON = m.EJSON ?? m.BSON?.EJSON ?? m.default?.EJSON;
} catch {
  /* handled below */
}
if (!EJSON) {
  console.error("✖ EJSON serializer not found — is the `mongodb` package installed?");
  process.exit(1);
}

// ── args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const OUT = argOf("out") ?? path.join("backups", "migration", new Date().toISOString().slice(0, 10));
const URI = argOf("uri") ?? process.env.DATABASE_URL;

if (!URI) {
  console.error("✖ No connection string. Set DATABASE_URL or pass --uri");
  process.exit(1);
}

// ── helpers ─────────────────────────────────────────────────────────
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Stream a whole collection to an EJSON array file without holding
 *  the full document list in memory (flat RAM usage even for 40k+ docs). */
async function dumpCollection(collection, filePath) {
  const handle = await (await import("node:fs/promises")).open(filePath, "w");
  try {
    await handle.write("[");
    let count = 0;
    const cursor = collection.find({}, { batchSize: 1000 });
    for await (const doc of cursor) {
      const chunk = (count === 0 ? "" : ",") + EJSON.stringify(doc, null, 0, { relaxed: false });
      await handle.write(chunk);
      count++;
    }
    await handle.write("]");
    await handle.close();
    return count;
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

// ── main ────────────────────────────────────────────────────────────
const client = new MongoClient(URI, { serverSelectionTimeoutMS: 20_000 });
await client.connect();
const db = client.db(); // db name comes from the URI path
const dbName = db.databaseName;

const collectionsMeta = await db.listCollections().toArray();
const names = collectionsMeta.map((c) => c.name).sort();
console.log(`▶ ${dbName} — ${names.length} collections`);

const dumpDir = path.join(OUT, "dump");
await mkdir(dumpDir, { recursive: true });

const manifest = {
  tool: "imach-back/scripts/backup-db.mjs",
  db: dbName,
  createdAt: new Date().toISOString(),
  format: "EJSON (mongodb Extended JSON, relaxed:false)",
  collections: {},
  totals: { collections: 0, documents: 0, bytes: 0 },
};

for (const name of names) {
  const collection = db.collection(name);
  const filePath = path.join(dumpDir, `${name}.json`);
  const count = await dumpCollection(collection, filePath);
  let indexes = [];
  try {
    indexes = await collection.indexes();
  } catch {
    /* some managed clusters hide index listing — keep going */
  }
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(filePath);
  const entry = {
    count,
    bytes: raw.byteLength,
    sha256: sha256(raw),
    indexes: indexes.map((ix) => ({ name: ix.name, key: ix.key, ...(ix.unique ? { unique: true } : {}), ...(ix.sparse ? { sparse: true } : {}) })),
  };
  manifest.collections[name] = entry;
  manifest.totals.collections++;
  manifest.totals.documents += count;
  manifest.totals.bytes += raw.byteLength;
  console.log(`  ✔ ${name.padEnd(24)} ${String(count).padStart(7)} docs  ${(raw.byteLength / 1024 / 1024).toFixed(2)} MB`);
}

const manifestPath = path.join(OUT, "manifest.json");
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

// ── single archive (this is the artifact pushed/stored) ────────────
const archive = path.join(OUT, `${dbName}-${manifest.createdAt.slice(0, 10)}.tar.gz`);
execFileSync("tar", ["-czf", archive, "-C", OUT, "dump", "manifest.json"], { stdio: "inherit" });
const { stat } = await import("node:fs/promises");
const archiveStat = await stat(archive);
console.log(`\n▣ manifest → ${manifestPath}`);
console.log(`▣ archive  → ${archive} (${(archiveStat.size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`▣ totals   → ${manifest.totals.collections} collections · ${manifest.totals.documents} documents`);

await client.close();
