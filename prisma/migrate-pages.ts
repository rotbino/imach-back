/**
 * One-shot migration → the Page era (spec فاز ۰).
 *
 *   1) every business gets its two pages: SELL (catalog) + BUY (purchase desk)
 *   2) every follow edge is re-pointed: buyer business → its BUY page,
 *      supplier business → its SELL page (the typed follow graph)
 *   3) legacy keys buyerId / supplierId are removed from Follow documents
 *
 * Uses the raw MongoDB driver so it is independent of the generated Prisma
 * client. Idempotent: re-running skips pages that already exist and follows
 * already on the new shape. Run BEFORE `npx prisma db push` (the new unique
 * index would reject the legacy null-page follow documents).
 *
 * Run:  npx tsx prisma/migrate-pages.ts
 */
import { MongoClient, ObjectId } from "mongodb";

const uri = process.env.DATABASE_URL ?? process.env.MONGO_URL;
if (!uri) throw new Error("DATABASE_URL / MONGO_URL is required");

async function main(): Promise<void> {
  const client = new MongoClient(uri as string);
  await client.connect();
  const db = client.db();
  const businesses = db.collection("Business");
  const pages = db.collection("Page");
  const follows = db.collection("Follow");

  // ── 1) pages for every business ──
  let pagesCreated = 0;
  const bizDocs = await businesses.find({}, { projection: { _id: 1 } }).toArray();
  for (const biz of bizDocs) {
    for (const type of ["SELL", "BUY"]) {
      const exists = await pages.findOne({ businessId: biz._id, type }, { projection: { _id: 1 } });
      if (exists) continue;
      await pages.insertOne({ _id: new ObjectId(), type, businessId: biz._id, createdAt: new Date(), updatedAt: new Date() });
      pagesCreated++;
    }
  }
  console.log(`  businesses: ${bizDocs.length}, pages created: ${pagesCreated}`);

  // ── 2) page id lookup: `${businessId}:${type}` → _id ──
  const pageIdOf = new Map<string, ObjectId>();
  await pages.find({}, { projection: { _id: 1, businessId: 1, type: 1 } }).forEach((p) => {
    pageIdOf.set(`${p.businessId.toString()}:${p.type}`, p._id as ObjectId);
  });

  // ── 3) re-point follows ──
  let migrated = 0;
  let skipped = 0;
  let removed = 0;
  const followDocs = await follows.find({}).toArray();
  for (const f of followDocs) {
    if (f.followerPageId && f.supplierPageId) {
      skipped++;
      continue; // already on the new shape
    }
    const buyerId = f.buyerId as ObjectId | undefined;
    const supplierId = f.supplierId as ObjectId | undefined;
    const followerPageId = buyerId ? pageIdOf.get(`${buyerId.toString()}:BUY`) : undefined;
    const supplierPageId = supplierId ? pageIdOf.get(`${supplierId.toString()}:SELL`) : undefined;
    if (!followerPageId || !supplierPageId) {
      console.warn(`  ! follow ${f._id}: page missing (${buyerId} → ${supplierId}) — removed`);
      await follows.deleteOne({ _id: f._id });
      removed++;
      continue;
    }
    await follows.updateOne(
      { _id: f._id },
      {
        $set: { followerPageId, supplierPageId, updatedAt: new Date() },
        $unset: { buyerId: "", supplierId: "" },
      }
    );
    migrated++;
  }
  console.log(`  follows: ${followDocs.length} scanned, ${migrated} migrated, ${skipped} already on pages, ${removed} removed`);

  await client.close();
  console.log("  done — now run: npx prisma db push");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
