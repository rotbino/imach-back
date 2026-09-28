/**
 * Re-classify Goods in 'jadid' — bulk approach for speed.
 *
 * Strategy:
 *   1. Get all Goods in jadid (3183 items)
 *   2. For each, sample one Product's metadata
 *   3. Resolve iMach category from metadata via BC_TO_IMACH
 *   4. Batch update Goods with new categoryId
 */
const { MongoClient } = require('mongodb');
const { BC_TO_IMACH } = require('./category-map');

const uri = "mongodb://uniqu434343:MirAli%40434343%2A@megancluster-shard-00-00.jm46r.mongodb.net:27017,megancluster-shard-00-01.jm46r.mongodb.net:27017,megancluster-shard-00-02.jm46r.mongodb.net:27017/imach_online_db?ssl=true&replicaSet=atlas-10bcqm-shard-0&authSource=admin&appName=MeganCluster";

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('imach_online_db');

  const jadidCat = await db.collection('Category').findOne({ slug: "jadid" });
  console.log('jadid _id:', jadidCat._id);

  const allCats = await db.collection('Category').find({}).toArray();
  const catBySlug = new Map(allCats.map(c => [c.slug, c]));

  const jadidGoods = await db.collection('Good').find({ categoryId: jadidCat._id }).toArray();
  console.log('Goods in jadid:', jadidGoods.length);

  // For each jadid good, find one product to get metadata
  // Use $in to batch — get all products whose goodId is in jadidGoods
  const jadidGoodIds = jadidGoods.map(g => g._id);
  console.log('Fetching sample product for each jadid good (via $in)...');
  const sampleProducts = await db.collection('Product').aggregate([
    { $match: { goodId: { $in: jadidGoodIds } } },
    { $group: { _id: "$goodId", sample: { $first: "$$ROOT" } } }
  ]).toArray();
  // Use string keys (ObjectId doesn't === match in JS Map)
  const sampleByGoodId = new Map(sampleProducts.map(s => [s._id.toString(), s.sample]));
  console.log('Got samples for ' + sampleByGoodId.size + ' goods');

  // Build updates
  const updates = [];
  const reasonCounts = { matched: 0, noProduct: 0, noBcCat: 0, noTaxCat: 0, noMapping: 0 };

  for (const g of jadidGoods) {
    const sample = sampleByGoodId.get(g._id.toString());
    if (!sample) {
      reasonCounts.noProduct++;
      continue;
    }

    const bcCat = sample.metadata?.barcodeapp_category;
    const bcSub = sample.metadata?.barcodeapp_subcategory;
    const taxCat = sample.metadata?.barcodeapp_taxonomy_category;

    let resolvedSlug = null;
    for (const cand of [bcCat, bcSub, taxCat]) {
      if (cand && BC_TO_IMACH[cand]) {
        resolvedSlug = BC_TO_IMACH[cand];
        break;
      }
    }

    if (!resolvedSlug) {
      if (!bcCat && !bcSub && !taxCat) reasonCounts.noBcCat++;
      else reasonCounts.noMapping++;
      continue;
    }

    const cat = catBySlug.get(resolvedSlug);
    if (!cat) {
      reasonCounts.noMapping++;
      continue;
    }

    updates.push({
      updateOne: {
        filter: { _id: g._id },
        update: { $set: { categoryId: cat._id, unit: cat.unit || "PIECE", updatedAt: new Date() } }
      }
    });
    reasonCounts.matched++;
  }

  console.log('');
  console.log('=== Update plan ===');
  console.log('To update:', updates.length);
  console.log('Reasons:', reasonCounts);

  // Bulk write in batches of 500
  if (updates.length > 0) {
    console.log('Executing bulk updates...');
    const BATCH = 500;
    for (let i = 0; i < updates.length; i += BATCH) {
      const batch = updates.slice(i, i + BATCH);
      await db.collection('Good').bulkWrite(batch);
      process.stdout.write('.');
    }
    console.log('');
  }

  // Final counts
  console.log('');
  console.log('=== Final goods per category (top 25) ===');
  const finalCats = await db.collection('Good').aggregate([
    { $group: { _id: "$categoryId", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 25 }
  ]).toArray();

  for (const fc of finalCats) {
    const cat = await db.collection('Category').findOne({ _id: fc._id });
    console.log('  ' + (cat?.nameFa || 'unknown') + ' (' + cat?.slug + '): ' + fc.count + ' goods');
  }

  // Also count products per category now
  console.log('');
  console.log('=== Final products per category (top 25) ===');
  const finalProds = await db.collection('Product').aggregate([
    { $lookup: { from: 'Good', localField: 'goodId', foreignField: '_id', as: 'good' } },
    { $unwind: '$good' },
    { $group: { _id: "$good.categoryId", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 25 }
  ]).toArray();
  for (const fp of finalProds) {
    const cat = await db.collection('Category').findOne({ _id: fp._id });
    console.log('  ' + (cat?.nameFa || 'unknown') + ' (' + cat?.slug + '): ' + fp.count + ' products');
  }

  await client.close();
}

main().catch(e => { console.error(e); process.exit(1); });
