// M8 debug — dump the specific thread + recent orders + businesses
const { MongoClient } = require('mongodb');
const fs = require('fs');
const env = fs.readFileSync('/home/z/my-project/imach-back/.env', 'utf8');
const mongo = env.match(/^DATABASE_URL="?([^"\n]*)"?/m)[1];
(async () => {
  const c = new MongoClient(mongo);
  await c.connect();
  const db = c.db();
  const tid = process.argv[2];
  if (tid) {
    const { ObjectId } = require('mongodb');
    const t = await db.collection('Thread').findOne({ _id: new ObjectId(tid) });
    console.log('thread:', JSON.stringify(t, null, 1));
  }
  const orders = await db.collection('Order').find({}).sort({ createdAt: -1 }).limit(3).toArray();
  for (const o of orders) {
    console.log('order:', String(o._id), 'buyer:', o.buyerId, 'seller:', o.sellerId, 'status:', o.status, 'items:', JSON.stringify(o.items).slice(0, 120));
  }
  const bizs = await db.collection('Business').find({}).sort({ createdAt: -1 }).limit(4).toArray();
  for (const b of bizs) console.log('biz:', String(b._id), b.name, 'owner:', b.ownerId);
  const threads = await db.collection('Thread').find({}).sort({ createdAt: -1 }).limit(5).toArray();
  for (const t of threads) console.log('thread:', String(t._id), 'a:', t.aId, 'b:', t.bId, 'ctx:', t.contextType ?? null, String(t.contextRefId ?? ''), 'key:', JSON.stringify(t.contextKey ?? null));
  await c.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
