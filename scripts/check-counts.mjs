#!/usr/bin/env node
/** sanity check — collection count + total docs (read-only) */
import { MongoClient } from "mongodb";
const uri = process.argv[2];
const c = new MongoClient(uri);
await c.connect();
const db = c.db();
const cols = await db.collections();
let total = 0;
for (const col of cols) total += await col.countDocuments({});
console.log("collections:", cols.length, "total docs:", total);
await c.close();
