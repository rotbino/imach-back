#!/usr/bin/env node
/**
 * m11-explain.mjs — M11 §پرفورمنس (سند ۰۸): explain روی کوئری‌های داغ
 * ─────────────────────────────────────────────────────────────────
 * هدف: «ایندکس‌های مرکب پوششی روی کوئری‌های داغ (orders two-side,
 * supply-proposals, watched+lowStock) + explain روی فیدها».
 *
 * برای هر کوئریٔ داغ، پلن برندهٔ Mongo را می‌گیرد و می‌گوید:
 *   IXSCAN <index>  → ایندکس استفاده شد (نامش)
 *   COLLSCAN        → اسکن کامل — ایندکس ندارد
 *   SORT in-mem     → مرتب‌سازی حافظه‌ای (اینکس مرتب‌شده ندارد)
 *
 * اجرا:  node scripts/m11-explain.mjs
 * خروجی: جدول خلاصه + exit 1 اگر کوئری داغی COLLSCAN خالص داشت.
 */
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

/* سندباکس خودش DATABASE_URL مسیری (file:…) در env می‌گذارد — override
   لازم است تا .env واقعی پروژه برنده شود. */
dotenv.config({ path: ".env", override: true });
const uri = process.env.DATABASE_URL;
if (!uri) {
  console.error("DATABASE_URL نیست — .env را بسازید.");
  process.exit(2);
}

const QUERIES = [
  {
    name: "orders/sell-side (۰۹ فهرست سفارش فروشنده)",
    coll: "Order",
    filter: (ids) => ({ sellerId: ids.biz, status: { $in: ["NEW", "ACCEPTED", "SENT"] } }),
    sort: { createdAt: -1 },
  },
  {
    name: "orders/buy-side (۲۸ فهرست سفارش خریدار)",
    coll: "Order",
    filter: (ids) => ({ buyerId: ids.biz, status: { $in: ["NEW", "ACCEPTED", "SENT"] } }),
    sort: { createdAt: -1 },
  },
  {
    name: "supply-proposals/inbox خریدار (۲۰ پیشنهادهای تامین)",
    coll: "SupplyProposal",
    filter: (ids) => ({ buyerId: ids.biz, status: "OPEN" }),
    sort: { createdAt: -1 },
  },
  {
    name: "watched-feed (۲۰ لیست خرید — واکشی کالاهای رصدشده)",
    coll: "WatchedGood",
    filter: (ids) => ({ businessId: ids.biz }),
    sort: { createdAt: -1 },
  },
  {
    name: "watched+lowStock (۲۰ج در حال اتمام موجودی)",
    coll: "WatchedGood",
    filter: (ids) => ({ businessId: ids.biz, lowStock: true, archivedAt: null }),
    sort: { createdAt: -1 },
  },
  {
    name: "buy-list feed (۲۰ ردیف‌های BUY فعال کسب‌وکار)",
    coll: "Listing",
    filter: (ids) => ({ businessId: ids.biz, mode: { $in: ["BUY", "BOTH"] }, isActive: true }),
    sort: { createdAt: -1 },
  },
  {
    name: "sell-catalog feed (۰۵ کاتالوگ فروشنده)",
    coll: "Listing",
    filter: (ids) => ({ businessId: ids.biz, mode: { $in: ["SELL", "BOTH"] }, isActive: true }),
    sort: { updatedAt: -1 },
  },
];

function planSummary(explain) {
  /* پلن مسطح است (SORT→FETCH→IXSCAN)؛ Atlas زیر shards همین ساختار را
     دارد — بازگشتی پیمایش می‌کنیم. */
  let ix = null, collscan = false, memsort = false;
  const stages = [];
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.stage) {
      stages.push(n.stage);
      if (n.stage === "IXSCAN" && !ix) ix = n.indexName;
      if (n.stage === "COLLSCAN") collscan = true;
      if (n.stage === "SORT") memsort = true;
    }
    if (n.inputStage) walk(n.inputStage);
    if (Array.isArray(n.inputStages)) n.inputStages.forEach(walk);
    if (Array.isArray(n.shards)) n.shards.forEach((sh) => walk(sh?.queryPlanner?.winningPlan));
  })(explain?.queryPlanner?.winningPlan);
  return { ix, collscan, memsort, stages: stages.join("→") };
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
await client.connect();
const db = client.db();

// یک کسب‌وکار واقعی با WatchedGood و یک با Listing — کوئری‌ها واقعی بمانند
const bizW = await db.collection("WatchedGood").findOne({}, { projection: { businessId: 1 } });
const bizL = await db.collection("Listing").findOne({ mode: "SELL" }, { projection: { businessId: 1 } });
const ids = { biz: bizW?.businessId ?? bizL?.businessId };
if (!ids.biz) {
  console.error("هیچ businessId نمونه‌ای پیدا نشد — دیتابیس خالی؟");
  process.exit(2);
}

let bad = 0;
console.log("═══ M11 explain — کوئری‌های داغ ═══\n");
for (const q of QUERIES) {
  const filter = q.filter(ids);
  const explain = await db.command({ explain: { find: q.coll, filter, sort: q.sort }, verbosity: "queryPlanner" });
  const s = planSummary(explain);
  const verdict = s.collscan && !s.ix ? "✗ COLLSCAN" : s.ix ? `✓ IXSCAN ${s.ix}` : "? " + s.stages;
  const sortNote = s.memsort ? " · SORT in-mem" : "";
  console.log(`${verdict.padEnd(46)} ${q.name}${sortNote}`);
  if (s.collscan && !s.ix) bad++;
}

console.log(`\n═══ ${bad === 0 ? "همه از ایندکس می‌خوانند" : bad + " کوئری بدون ایندکس"} ═══`);
await client.close();
process.exit(bad === 0 ? 0 : 1);
