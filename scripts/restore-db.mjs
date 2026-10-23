#!/usr/bin/env node
/**
 * iMach — Database Restore (migration-safe)
 * ------------------------------------------------------------
 * Rebuilds a database from a backup produced by backup-db.mjs
 * (either the folder with dump/ + manifest.json, or the single
 * .tar.gz archive). Recreates every collection and its indexes,
 * then verifies per-collection counts against the manifest.
 *
 * Usage:
 *   node restore-db.mjs backups/migration/2026-10-05/imach_online_db-2026-10-05.tar.gz \
 *        --target-uri "mongodb+srv://..." --target-db imach_online_db [--drop-existing]
 *
 * Safety: restoring into an existing non-empty database requires
 * the explicit --drop-existing flag (drops ALL its collections first).
 */
import { MongoClient } from "mongodb";
import { readFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const EJSON_NS = "mongodb";
let EJSON;
try {
  const m = await import(EJSON_NS);
  EJSON = m.EJSON ?? m.BSON?.EJSON ?? m.default?.EJSON;
} catch {}
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
const SOURCE = argv.find((a) => !a.startsWith("--"));
const TARGET_URI = argOf("target-uri") ?? process.env.DATABASE_URL;
const TARGET_DB = argOf("target-db");
const DROP = argv.includes("--drop-existing");
const BATCH = 500;

if (!SOURCE || !TARGET_URI || !TARGET_DB) {
  console.error("Usage: node restore-db.mjs <archive.tar.gz | folder> --target-uri <uri> --target-db <name> [--drop-existing]");
  process.exit(1);
}

// ── resolve source folder (untar if needed) ─────────────────────────
let srcDir = SOURCE;
let tmpDir = null;
try {
  await readdir(SOURCE); // folder?
} catch {
  tmpDir = await mkdtemp(path.join(tmpdir(), "imach-restore-"));
  execFileSync("tar", ["-xzf", SOURCE, "-C", tmpDir]);
  srcDir = tmpDir;
}

const manifest = JSON.parse(await readFile(path.join(srcDir, "manifest.json"), "utf8"));
console.log(`▶ source: ${manifest.db} @ ${manifest.createdAt} (${manifest.totals.collections} collections · ${manifest.totals.documents} docs)`);

// ── connect & restore ───────────────────────────────────────────────
const client = new MongoClient(TARGET_URI, { serverSelectionTimeoutMS: 20_000 });
await client.connect();
const db = client.db(TARGET_DB);

const existing = await db.listCollections().toArray();
if (existing.length > 0) {
  if (!DROP) {
    console.error(`✖ target database "${TARGET_DB}" is NOT empty (${existing.length} collections).`);
    console.error("  Pass --drop-existing to wipe it first (destructive!) or choose another --target-db.");
    process.exit(1);
  }
  for (const c of existing) {
    await db.collection(c.name).drop();
    console.log(`  ⚠ dropped existing collection ${c.name}`);
  }
}

let failures = 0;
for (const [name, meta] of Object.entries(manifest.collections)) {
  const raw = await readFile(path.join(srcDir, "dump", `${name}.json`), "utf8");
  const docs = EJSON.parse(raw);
  const collection = db.collection(name);
  for (let i = 0; i < docs.length; i += BATCH) {
    await collection.insertMany(docs.slice(i, i + BATCH), { ordered: false });
  }
  for (const ix of meta.indexes ?? []) {
    if (ix.name === "_id_") continue;
    try {
      await collection.createIndex(ix.key, { name: ix.name, ...(ix.unique ? { unique: true } : {}), ...(ix.sparse ? { sparse: true } : {}) });
    } catch (err) {
      console.warn(`  ⚠ index ${name}.${ix.name}: ${err.message}`);
    }
  }
  const restored = await collection.countDocuments();
  const ok = restored === meta.count;
  if (!ok) failures++;
  console.log(`  ${ok ? "✔" : "✖"} ${name.padEnd(24)} ${restored}/${meta.count}`);
}

if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
await client.close();

if (failures > 0) {
  console.error(`\n✖ RESTORE VERIFICATION FAILED for ${failures} collection(s)`);
  process.exit(1);
}
console.log(`\n▣ restore into "${TARGET_DB}" verified — all counts match the manifest.`);
