/**
 * rebuild-goods.js — Replace legacy goods with reference goods.
 * Usage: node rebuild-goods.js --dry-run | --apply
 */
const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');

const uri = "mongodb://uniqu434343:MirAli%40434343%2A@megancluster-shard-00-00.jm46r.mongodb.net:27017,megancluster-shard-00-01.jm46r.mongodb.net:27017,megancluster-shard-00-02.jm46r.mongodb.net:27017/imach_online_db?ssl=true&replicaSet=atlas-10bcqm-shard-0&authSource=admin&appName=MeganCluster";
const REF_FILE = "/home/z/imach-back/local-data/reference/reference-catalog-v3.json";

function normalizeFa(text) {
  if (!text) return "";
  return text
    .replace(/[\u06F0-\u06F9]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x06F0 + 0x0030))
    .replace(/[\u0660-\u0669]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x0660 + 0x0030))
    .replace(/ي/g, "ی").replace(/ك/g, "ک")
    .replace(/أ|إ|آ/g, "ا").replace(/ة/g, "ه")
    .replace(/ؤ/g, "و").replace(/ئ/g, "ی")
    .replace(/\u200c/g, " ")
    .toLowerCase().trim();
}

function matchProduct(product, refGoods) {
  const label = normalizeFa(product.label || "");
  const cleanName = normalizeFa(product.metadata?.clean_name || "");
  const originalName = normalizeFa(product.metadata?.original_name || "");
  const subCat = product.metadata?.barcodeapp_subcategory || "";
  const taxCat = product.metadata?.barcodeapp_taxonomy_category || "";
  const text = label + " " + cleanName + " " + originalName + " " + normalizeFa(subCat) + " " + normalizeFa(taxCat);

  const scores = [];
  for (const g of refGoods) {
    let score = 0;
    const excludes = g.excludeKeywords || [];
    if (excludes.some(ex => text.includes(normalizeFa(ex)))) continue;
    const mustMatchAny = g.must_match_any_keyword_group || [];
    let groupMatched = 0;
    let allGroupsMatched = true;
    for (const group of mustMatchAny) {
      const matched = group.some(kw => text.includes(normalizeFa(kw)));
      if (!matched) { allGroupsMatched = false; break; }
      groupMatched++;
    }
    if (mustMatchAny.length > 0 && !allGroupsMatched) continue;
    const keywords = g.keywords || [];
    if (keywords.length > 0) {
      const anyKeywordPresent = keywords.some(kw => text.includes(normalizeFa(kw)));
      if (!anyKeywordPresent) continue;
      score += 100 * keywords.filter(kw => text.includes(normalizeFa(kw))).length;
    }
    score += groupMatched * 50;
    const aliases = g.aliases || [];
    for (const alias of aliases) {
      if (text.includes(normalizeFa(alias))) score += 30;
    }
    if (cleanName && normalizeFa(g.nameFa).includes(cleanName)) score += 50;
    if (text.includes(normalizeFa(g.nameFa))) score += 80;
    if (subCat && normalizeFa(subCat).includes(normalizeFa(g.nameFa))) score += 200;
    scores.push({ good: g, score });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores[0] || null;
}

async function main() {
  const dryRun = !process.argv.includes("--apply");
  console.log("=== Rebuild Goods ===");
  console.log("Mode: " + (dryRun ? "DRY-RUN" : "LIVE (--apply)"));

  const refCatalog = JSON.parse(fs.readFileSync(REF_FILE, 'utf8'));
  const refGoods = refCatalog.goods;
  console.log("Reference goods:", refGoods.length);

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('imach_online_db');

  const admin = await db.collection('User').findOne({ role: "ADMIN" });
  const adminId = admin._id;

  const allCats = await db.collection('Category').find({}).toArray();
  const catBySlug = new Map(allCats.map(c => [c.slug, c]));

  // Match all products
  console.log("Matching all products...");
  const total = await db.collection('Product').countDocuments();
  const productToRefGood = new Map();
  const matchStats = {};
  let unmatchedCount = 0;
  let processed = 0;

  const cursor = db.collection('Product').find({});
  while (await cursor.hasNext()) {
    const product = await cursor.next();
    const result = matchProduct(product, refGoods);
    if (result) {
      productToRefGood.set(product._id.toString(), result.good.slug);
      matchStats[result.good.slug] = (matchStats[result.good.slug] || 0) + 1;
    } else {
      unmatchedCount++;
    }
    processed++;
    if (processed % 10000 === 0) {
      process.stdout.write('\r  ' + processed + '/' + total + ' (' + Math.round(processed/total*100) + '%)');
    }
  }
  console.log('\n  Matched: ' + (processed - unmatchedCount) + ' | Unmatched: ' + unmatchedCount);

  if (dryRun) {
    console.log("\n=== DRY-RUN summary ===");
    console.log("Current goods:", await db.collection('Good').countDocuments());
    console.log("Would insert:", refGoods.length, "new reference goods");
    console.log("Would update:", processed - unmatchedCount, "products' goodId");
    console.log("Unmatched (→ 'سایر'):", unmatchedCount);
    console.log("\nTop 15 ref goods by product count:");
    const sorted = Object.entries(matchStats).sort((a, b) => b[1] - a[1]);
    for (const [slug, count] of sorted.slice(0, 15)) {
      console.log("  " + slug.padEnd(35) + count + " products");
    }
    await client.close();
    return;
  }

  // LIVE mode
  const now = new Date();

  // Backup
  console.log("\nPhase 2: Backup current goods...");
  const backupFile = "/home/z/imach-back/local-data/backup-goods-" + now.toISOString().slice(0,10) + ".json";
  const allCurrentGoods = await db.collection('Good').find({}).toArray();
  fs.writeFileSync(backupFile, JSON.stringify(allCurrentGoods, null, 2));
  console.log("  Backup saved:", backupFile, "(" + allCurrentGoods.length + " goods)");

  // Insert reference goods
  console.log("\nPhase 3: Inserting " + refGoods.length + " reference goods...");
  const goodsToInsert = [];
  for (const g of refGoods) {
    const cat = catBySlug.get(g.categoryId);
    if (!cat) { console.warn("  ⚠️ Category not found:", g.categoryId, "for", g.slug); continue; }
    goodsToInsert.push({
      nameFa: g.nameFa,
      nameEn: g.nameEn || null,
      aliases: g.aliases || [],
      searchText: normalizeFa(g.nameFa),
      unit: g.unit || cat.unit || "PIECE",
      categoryId: cat._id,
      hsCode: g.hsCode || null,
      source: "SEED",
      status: "ACTIVE",
      creatorRole: "ADMIN",
      createdById: adminId,
      createdAt: now,
      updatedAt: now,
    });
  }
  const insertResult = await db.collection('Good').insertMany(goodsToInsert);
  console.log("  Inserted:", insertResult.insertedCount);

  // Build slug → _id map
  const insertedGoods = await db.collection('Good').find({ createdAt: now }).toArray();
  const refGoodIdBySlug = new Map();
  for (const ig of insertedGoods) {
    const refGood = refGoods.find(rg => normalizeFa(rg.nameFa) === ig.searchText);
    if (refGood) refGoodIdBySlug.set(refGood.slug, ig._id);
  }
  console.log("  Mapped ref good IDs:", refGoodIdBySlug.size);

  // Update products' goodId
  console.log("\nPhase 4: Updating products' goodId...");
  let updatedCount = 0;
  const BATCH = 1000;
  let updates = [];
  for (const [productIdStr, refGoodSlug] of productToRefGood) {
    const newGoodId = refGoodIdBySlug.get(refGoodSlug);
    if (!newGoodId) continue;
    updates.push({
      updateOne: {
        filter: { _id: new ObjectId(productIdStr) },
        update: { $set: { goodId: newGoodId, updatedAt: now } },
      },
    });
    if (updates.length >= BATCH) {
      const r = await db.collection('Product').bulkWrite(updates);
      updatedCount += r.modifiedCount;
      updates = [];
      process.stdout.write('\r  Updated ' + updatedCount + ' products...');
    }
  }
  if (updates.length > 0) {
    const r = await db.collection('Product').bulkWrite(updates);
    updatedCount += r.modifiedCount;
  }
  console.log('\n  Total products updated:', updatedCount);

  // Handle unmatched → "سایر"
  if (unmatchedCount > 0) {
    console.log("\nPhase 5: Handling unmatched products...");
    const jadidCat = catBySlug.get("jadid");
    let unknownGood = await db.collection('Good').findOne({ searchText: normalizeFa("سایر") });
    if (!unknownGood) {
      const r = await db.collection('Good').insertOne({
        nameFa: "سایر",
        nameEn: "Other",
        aliases: [],
        searchText: normalizeFa("سایر"),
        unit: "PIECE",
        categoryId: jadidCat._id,
        hsCode: null,
        source: "SEED",
        status: "ACTIVE",
        creatorRole: "ADMIN",
        createdById: adminId,
        createdAt: now,
        updatedAt: now,
      });
      unknownGood = { _id: r.insertedId };
    }
    // Update products still pointing to old goods
    const oldGoodIds = new Set(allCurrentGoods.map(g => g._id.toString()));
    const stillOldUpdates = [];
    const allProducts = await db.collection('Product').find({}, { projection: { _id: 1, goodId: 1 } }).toArray();
    for (const p of allProducts) {
      if (p.goodId && oldGoodIds.has(p.goodId.toString())) {
        stillOldUpdates.push({
          updateOne: {
            filter: { _id: p._id },
            update: { $set: { goodId: unknownGood._id, updatedAt: now } },
          },
        });
      }
      if (stillOldUpdates.length >= BATCH) {
        await db.collection('Product').bulkWrite(stillOldUpdates);
        stillOldUpdates.length = 0;
        process.stdout.write('.');
      }
    }
    if (stillOldUpdates.length > 0) await db.collection('Product').bulkWrite(stillOldUpdates);
    console.log('\n  Unmatched products moved to "سایر"');
  }

  // Delete old goods
  console.log("\nPhase 6: Deleting old goods...");
  const deleteResult = await db.collection('Good').deleteMany({ createdAt: { $lt: now } });
  console.log("  Deleted old goods:", deleteResult.deletedCount);

  // Final summary
  console.log("\n=== Final summary ===");
  console.log("Total goods:", await db.collection('Good').countDocuments());
  console.log("Total products:", await db.collection('Product').countDocuments());
  console.log("\nGoods per category (top 20):");
  const finalCats = await db.collection('Good').aggregate([
    { $group: { _id: "$categoryId", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 20 },
  ]).toArray();
  for (const g of finalCats) {
    const cat = allCats.find(c => c._id.toString() === g._id.toString());
    console.log("  " + (cat?.slug || '?').padEnd(22) + ': ' + g.count + ' goods');
  }

  await client.close();
  console.log("\n✅ Rebuild complete!");
}

main().catch(e => { console.error(e); process.exit(1); });
