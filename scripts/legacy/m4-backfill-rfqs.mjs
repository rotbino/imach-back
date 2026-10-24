#!/usr/bin/env node
/**
 * iMach — M4 backfill: استعلام چندقلمی (idempotent)
 * ------------------------------------------------------------
 * دو کار فقط روی ردیف‌های legacy (فقط وقتی فیلد null است — بی‌خطر برای
 * اجرای مکرر):
 *
 *  1) Inquiry.items — ردیف‌های تک‌قلمیِ قدیمی: [{goodId, qty: volume,
 *     listingId}] از join خود رکورد (listing.goodId).
 *
 *  2) Offer.rfqGroupId + Offer.prices — پیوند مستقیم پیشنهاد→گروه با همان
 *     هیوریستیک خواندنی getMyRfqs (listingId:sellerId + قید زمانی):
 *     جدیدترین استعلامِ همان جفت که قبل از پیشنهاد ساخته شده. سرد
 *     (offerBuyRequest بدون استعلام) دست‌نخورده می‌ماند = null.
 *     prices = [priceMinor] (تک‌قلمی).
 *
 * Line قرمز: هیچ فیلد موجودی بازنویسی نمی‌شود؛ فقط فیلدهای تازهٔ M4.
 *
 * Usage:
 *   node scripts/m4-backfill-rfqs.mjs <mongo-uri>
 */
import { MongoClient } from "mongodb";

const uri = process.argv[2];
if (!uri) {
  console.error("✖ Usage: node scripts/m4-backfill-rfqs.mjs <mongo-uri>");
  process.exit(1);
}

const client = new MongoClient(uri);
await client.connect();
const db = client.db();
// نام کالکشن‌های Prisma+MongoDB در این پروژه «مفرد» است (Inquiry/Offer/Listing)
const inq = db.collection("Inquiry");
const off = db.collection("Offer");
const lst = db.collection("Listing");

// ── ۱) Inquiry.items ─────────────────────────────────────────────
const bareInquiries = await inq
  .find({ $or: [{ items: null }, { items: { $exists: false } }] })
  .project({ listingId: 1, volume: 1 })
  .toArray();

let inqFilled = 0;
for (const row of bareInquiries) {
  const listing = await lst.findOne(
    { _id: row.listingId },
    { projection: { goodId: 1 } }
  );
  if (!listing?.goodId) {
    console.log(`  ↷ inquiry ${row._id}: listing بدون goodId — رد شد`);
    continue;
  }
  await inq.updateOne(
    { _id: row._id },
    {
      $set: {
        items: [{ goodId: listing.goodId, qty: row.volume ?? 1, listingId: row.listingId }],
      },
    }
  );
  inqFilled++;
}
console.log(`✔ Inquiry.items: ${inqFilled} ردیف تک‌قلمی پر شد`);

// ── ۲) Offer.rfqGroupId + prices (هیوریستیک listing:seller + زمان) ──
const bareOffers = await off
  .find({ rfqGroupId: null })
  .project({ listingId: 1, sellerId: 1, buyerId: 1, priceMinor: 1, createdAt: 1 })
  .toArray();

let offLinked = 0;
let offCold = 0;
for (const o of bareOffers) {
  const target = await inq
    .find({
      listingId: o.listingId,
      sellerId: o.sellerId,
      buyerId: o.buyerId,
      createdAt: { $lte: o.createdAt },
    })
    .sort({ createdAt: -1 })
    .limit(1)
    .project({ rfqGroupId: 1 })
    .next();
  if (!target) {
    offCold++;
    continue; // سرد — بدون استعلام
  }
  await off.updateOne(
    { _id: o._id },
    { $set: { rfqGroupId: target.rfqGroupId ?? target._id.toString(), prices: [o.priceMinor] } }
  );
  offLinked++;
}
console.log(`✔ Offer پیوند/قیمت: ${offLinked} پیوند شد · ${offCold} سرد ماند`);

await client.close();
console.log("— پایان (idempotent: دوباره اجرا شود فقط ردیف‌های تازه را می‌گیرد)");
