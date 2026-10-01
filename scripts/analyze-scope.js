/**
 * Analyze scope: which top-level iMach categories contain the imported products.
 */
const { MongoClient } = require('mongodb');
const uri = "mongodb://uniqu434343:MirAli%40434343%2A@megancluster-shard-00-00.jm46r.mongodb.net:27017,megancluster-shard-00-01.jm46r.mongodb.net:27017,megancluster-shard-00-02.jm46r.mongodb.net:27017/imach_online_db?ssl=true&replicaSet=atlas-10bcqm-shard-0&authSource=admin&appName=MeganCluster";

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('imach_online_db');

  const allCats = await db.collection('Category').find({}).toArray();
  const catById = new Map();
  for (const c of allCats) catById.set(c._id.toString(), c);

  // Find top-level categories (parentId null)
  const topLevel = allCats.filter(c => !c.parentId);
  console.log('=== Top-level iMach categories (' + topLevel.length + ') ===\n');
  console.log('slug'.padEnd(22) + ' | ' + 'nameFa'.padEnd(32) + ' | goods | products');
  console.log('-'.repeat(90));

  const rows = [];
  for (const t of topLevel) {
    // Find all descendants of t (including itself)
    const descendants = [];
    const stack = [t._id.toString()];
    while (stack.length > 0) {
      const id = stack.pop();
      descendants.push(id);
      for (const c of allCats) {
        if (c.parentId && c.parentId.toString() === id) {
          stack.push(c._id.toString());
        }
      }
    }
    const descObjIds = descendants.map(id => catById.get(id)._id);
    const goodsCount = await db.collection('Good').countDocuments({ categoryId: { $in: descObjIds } });
    const prodAgg = await db.collection('Product').aggregate([
      { $lookup: { from: 'Good', localField: 'goodId', foreignField: '_id', as: 'g' } },
      { $unwind: '$g' },
      { $match: { 'g.categoryId': { $in: descObjIds } } },
      { $count: 'n' }
    ]).toArray();
    const n = prodAgg[0]?.n || 0;
    rows.push({ slug: t.slug, nameFa: t.nameFa, goods: goodsCount, products: n });
  }

  rows.sort((a, b) => b.products - a.products);
  for (const r of rows) {
    console.log(r.slug.padEnd(22) + ' | ' + r.nameFa.padEnd(32) + ' | ' + String(r.goods).padStart(5) + ' | ' + String(r.products).padStart(8));
  }
  console.log('-'.repeat(90));
  console.log('Total'.padEnd(58) + ' | ' + String(rows.reduce((s, r) => s + r.goods, 0)).padStart(5) + ' | ' + String(rows.reduce((s, r) => s + r.products, 0)).padStart(8));

  await client.close();
}
main().catch(e => { console.error(e); process.exit(1); });
