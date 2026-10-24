#!/usr/bin/env node
/**
 * iMach — M10 e2e helper: temp admin token for QA scripts.
 * Promotes a user to ADMIN in the database, signs a 1h JWT with the
 * same secret the API uses (.env, quotes stripped), prints the token.
 * Usage: node scripts/mint-temp-admin.mjs <userId> [demote]
 *   demote → sets role back to MEMBER and prints "demoted".
 */
import { MongoClient, ObjectId } from "mongodb";
import jwt from "jsonwebtoken";
import fs from "node:fs";

const [userId, mode] = process.argv.slice(2);
if (!userId || !/^[a-f\d]{24}$/i.test(userId)) {
  console.error("usage: node scripts/mint-temp-admin.mjs <userId> [demote]");
  process.exit(1);
}
const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
const line = env.split("\n").find((l) => l.startsWith("JWT_SECRET=")) ?? "";
const raw = line.slice("JWT_SECRET=".length).trim();
const secret = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
const uri = env.match(/^DATABASE_URL="(.+)"$/m)[1];

const c = new MongoClient(uri);
await c.connect();
const users = c.db().collection("User");
if (mode === "demote") {
  await users.updateOne({ _id: new ObjectId(userId) }, { $set: { role: "MEMBER" } });
  console.log("demoted");
} else {
  await users.updateOne({ _id: new ObjectId(userId) }, { $set: { role: "ADMIN" } });
  const u = await users.findOne({ _id: new ObjectId(userId) });
  console.log(jwt.sign({ id: String(u._id), phone: u.phone, role: "ADMIN" }, secret, { expiresIn: "1h" }));
}
await c.close();
