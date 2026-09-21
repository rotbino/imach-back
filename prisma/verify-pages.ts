import { MongoClient } from "mongodb";

async function main(): Promise<void> {
  const c = new MongoClient(process.env.DATABASE_URL as string);
  await c.connect();
  const db = c.db();

  // new business created by the smoke test — its pages must exist
  const b = await db.collection("Business").findOne({ slug: "test-faz-sefr" });
  if (b) {
    const pages = await db.collection("Page").find({ businessId: b._id }).toArray();
    console.log("pages of new business:", pages.map((p) => p.type).sort().join(","));
    await db.collection("Business").deleteOne({ _id: b._id });
    await db.collection("Page").deleteMany({ businessId: b._id });
    console.log("cleaned up test business");
  } else {
    console.log("test business not found");
  }

  // global invariant: every business has exactly SELL+BUY pages
  const allPages = await db.collection("Page").find({}).toArray();
  const perBiz = new Map<string, Set<string>>();
  for (const p of allPages) {
    const key = p.businessId.toString();
    perBiz.set(key, (perBiz.get(key) ?? new Set()).add(p.type));
  }
  const bad = [...perBiz.entries()].filter(([, v]) => !v.has("SELL") || !v.has("BUY"));
  console.log(`businesses with pages: ${perBiz.size}, incomplete: ${bad.length}`);

  // follows all on pages, legacy keys gone
  const legacy = await db.collection("Follow").countDocuments({ $or: [{ buyerId: { $exists: true } }, { supplierId: { $exists: true } }] });
  const missing = await db.collection("Follow").countDocuments({ $or: [{ followerPageId: { $exists: false } }, { supplierPageId: { $exists: false } }] });
  console.log(`legacy follow docs: ${legacy}, missing page ids: ${missing}`);

  await c.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
