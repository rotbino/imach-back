// ساخت JWT ادمین برای تست اندپوینت‌های ادمین (با JWT_SECRET همان env)
const fs = require('fs');
const { MongoClient } = require('mongodb');
const jwt = require('jsonwebtoken');

const env = fs.readFileSync('/home/z/my-project/imach-web/.secrets/imach.env', 'utf8');
const JWT_SECRET = env.match(/^JWT_SECRET=(.+)$/m)[1].trim();
const MONGODB_URI = 'mongodb://uniqu434343:MirAli%40434343%2A@megancluster-shard-00-00.jm46r.mongodb.net:27017,megancluster-shard-00-01.jm46r.mongodb.net:27017,megancluster-shard-00-02.jm46r.mongodb.net/imach_online_db?ssl=true&replicaSet=atlas-10bcqm-shard-0&authSource=admin&appName=MeganCluster';

(async () => {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const users = client.db('imach_online_db').collection('User');
  const admin = await users.findOne({ role: 'ADMIN' }) ?? await users.findOne({});
  console.log(`کاربر: ${admin.phone} role=${admin.role} id=${admin._id}`);
  const token = jwt.sign({ id: String(admin._id), phone: admin.phone, role: admin.role }, JWT_SECRET, { expiresIn: '2h' });
  fs.writeFileSync('/tmp/admin-token.txt', token);
  console.log('توکن در /tmp/admin-token.txt ذخیره شد');
  await client.close();
})().catch(e => { console.error('💥', e.message); process.exit(1); });
