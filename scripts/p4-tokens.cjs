// فاز ۴ — توکن تست برای کاربرانی که Inquiry/Offer دارند (smoke-test API)
const fs = require('fs');
const { MongoClient } = require('mongodb');
const jwt = require('jsonwebtoken');

const env = fs.readFileSync('/home/z/my-project/repos/imach-back/.env', 'utf8');
const JWT_SECRET = env.match(/^JWT_SECRET=(.+)$/m)[1].trim();
const DATABASE_URL = env.match(/^DATABASE_URL=(.+)$/m)[1].trim();

(async () => {
  const client = new MongoClient(DATABASE_URL);
  await client.connect();
  const db = client.db();
  const inqs = await db.collection('Inquiry').find({}).sort({ _id: -1 }).limit(20).toArray();
  const buyerIds = [...new Set(inqs.map((i) => String(i.buyerId)))];
  const sellerIds = [...new Set(inqs.map((i) => String(i.sellerId)))];
  const bizs = await db.collection('Business').find({ _id: { $in: [...buyerIds, ...sellerIds].map((x) => require('mongodb').ObjectId.createFromHexString(x)) } }).toArray();
  const users = await db.collection('User').find({ _id: { $in: bizs.map((b) => b.ownerId).filter(Boolean).map((x) => require('mongodb').ObjectId.createFromHexString(String(x))) } }).toArray();
  const out = [];
  for (const u of users) {
    const own = bizs.filter((b) => String(b.ownerId) === String(u._id));
    const token = jwt.sign({ id: String(u._id), phone: u.phone, role: u.role }, JWT_SECRET, { expiresIn: '6h' });
    out.push({ phone: u.phone, role: u.role, userId: String(u._id), token, businesses: own.map((b) => ({ id: String(b._id), name: b.name, arms: b.arms })) });
  }
  fs.writeFileSync('/home/z/my-project/tool-results/p4-tokens.json', JSON.stringify(out, null, 2));
  console.log('users:', out.length);
  for (const o of out) console.log('-', o.phone, '| bizs:', o.businesses.map((b) => `${b.name}(${b.arms})`).join(' · '));
  await client.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
