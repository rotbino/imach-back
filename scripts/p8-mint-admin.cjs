// فاز ۸ — mint JWT ادمین با همان parse واقعی سرور (process.loadEnvFile)
// نکته: JWT_SECRET در .env گیومهٔ باز دارد؛ loadEnvFile خطوط بعدی را ادغام
// می‌کند — باید دقیقاً همان تفسیر سرور را به کار ببریم تا امضا معتبر شود.
const fs = require("fs");
const { MongoClient } = require("mongodb");
const jwt = require("jsonwebtoken");

process.loadEnvFile(".env");
const JWT_SECRET = process.env.JWT_SECRET;
const MONGODB_URI =
  "mongodb://uniqu434343:MirAli%40434343%2A@megancluster-shard-00-00.jm46r.mongodb.net:27017,megancluster-shard-00-01.jm46r.mongodb.net:27017,megancluster-shard-00-02.jm46r.mongodb.net/imach_online_db?ssl=true&replicaSet=atlas-10bcqm-shard-0&authSource=admin&appName=MeganCluster";

(async () => {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const users = client.db("imach_online_db").collection("User");
  const admin = (await users.findOne({ role: "ADMIN" })) ?? (await users.findOne({}));
  console.log(`کاربر: ${admin.phone} role=${admin.role}`);
  const token = jwt.sign(
    { id: String(admin._id), phone: admin.phone, role: admin.role },
    JWT_SECRET,
    { expiresIn: "2h" }
  );
  fs.writeFileSync("/tmp/admin-token.txt", token);
  // تأیید درجا
  jwt.verify(token, JWT_SECRET);
  console.log("توکن معتبر در /tmp/admin-token.txt ذخیره شد");
  await client.close();
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
