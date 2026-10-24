#!/usr/bin/env node
/**
 * m11-session.mjs — M11 QA: نشست واقعی برای ممیزی بصری/رفتاری اپ زنده.
 * ─────────────────────────────────────────────────────────────────
 * یک سطر RefreshToken معتبر برای کاربر منتخب می‌سازد (همان مسیر
 * issueSession) و raw توکن را چاپ می‌کند تا Playwright آن را به‌عنوان
 * کوکی httpOnly «imach_rt» بگذارد — اپ با boot() → /auth/refresh واقعی
 * احراز می‌شود. هیچ رمزی لازم نیست؛ سطر بعد از QA با m11-session.mjs
 * <raw> revoke قابل ابطال است.
 *
 * Usage:
 *   node scripts/m11-session.mjs            → { raw, ids… }
 *   node scripts/m11-session.mjs revoke RAW → revoke
 */
import fs from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";

const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
const p = (k) => {
  const m = env.match(new RegExp(`^${k}="?(.+?)"?$`, "m"));
  return m ? m[1] : "";
};
const uri = p("DATABASE_URL");
const [, , cmd, arg] = process.argv;

const c = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
await c.connect();
const db = c.db();

if (cmd === "revoke") {
  const hash = createHash("sha256").update(arg).digest("hex");
  const r = await db.collection("RefreshToken").updateOne({ tokenHash: hash }, { $set: { revokedAt: new Date() } });
  console.log(JSON.stringify({ revoked: r.modifiedCount === 1 }));
  await c.close();
  process.exit(0);
}

/* کاربر منتخب: ترد گفتگو بین «کسب‌وکارها»ست — کاربرِ مالکِ یکی از
   طرفین ترد را برمی‌داریم تا چت هم نمای واقعی داشته باشد؛ آگهی فعالِ
   همان کسب‌وکار (وگرنه هر آگهی فعال) برای نمای کالا. */
const thread = await db.collection("Thread").findOne({});
const biz = thread
  ? await db.collection("Business").findOne({ _id: thread.aId })
  : null;
const owner = biz ? await db.collection("User").findOne({ _id: biz.ownerId }) : null;
const finalUser = owner ?? (await db.collection("User").findOne({}));
if (!finalUser) {
  console.error("کاربری پیدا نشد");
  process.exit(1);
}

/* شناسه‌های نمونه برای مسیرهای پارامتری */
let listing = null;
if (biz) {
  listing = await db.collection("Listing").findOne({ businessId: biz._id, isActive: true, mode: { $in: ["SELL", "BOTH"] } });
}
listing ??= await db.collection("Listing").findOne({ isActive: true, mode: { $in: ["SELL", "BOTH"] } });
const anyThread = thread;
const slugBiz = await db.collection("Business").findOne({ slug: { $ne: null, $exists: true } });

/* سطر RefreshToken — همان issueSession */
const raw = randomBytes(48).toString("base64url");
const tokenHash = createHash("sha256").update(raw).digest("hex");
await db.collection("RefreshToken").insertOne({
  tokenHash,
  userId: String(finalUser._id),
  expiresAt: new Date(Date.now() + 2 * 86_400_000),
  createdAt: new Date(),
});

console.log(
  JSON.stringify(
    {
      raw,
      phone: finalUser.phone,
      userId: String(finalUser._id),
      businessId: biz ? String(biz._id) : null,
      listingId: listing ? String(listing._id) : null,
      threadId: anyThread ? String(anyThread._id) : null,
      slug: slugBiz?.slug ?? null,
    },
    null,
    0
  )
);
await c.close();
