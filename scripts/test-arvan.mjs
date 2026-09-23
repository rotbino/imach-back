/**
 * Arvan S3 smoke test — verifies the bucket credentials end-to-end:
 *   1. put a tiny jpeg (public-read)
 *   2. GET it back over HTTPS (the exact thing browsers will do)
 *   3. delete it
 * Run:  node scripts/test-arvan.mjs
 */
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { config } from "dotenv";
import { randomBytes } from "node:crypto";

config({ path: new URL("../.env", import.meta.url).pathname });

const endpoint = process.env.ARVAN_ENDPOINT;
const bucket = process.env.ARVAN_BUCKET_NAME;
const url = new URL(endpoint);
const bucketHosted = url.hostname.startsWith(`${bucket}.`);
const apiEndpoint = bucketHosted ? `${url.protocol}//${url.hostname.slice(bucket.length + 1)}` : endpoint;
const publicBase = bucketHosted ? endpoint.replace(/\/$/, "") : `${endpoint.replace(/\/$/, "")}/${bucket}`;

console.log({ endpoint, bucket, apiEndpoint, publicBase });

const s3 = new S3Client({
  endpoint: apiEndpoint,
  region: process.env.ARVAN_REGION,
  credentials: {
    accessKeyId: process.env.ARVAN_ACCESS_KEY,
    secretAccessKey: process.env.ARVAN_SECRET_KEY,
  },
  forcePathStyle: true,
});

// 1×1 red pixel jpeg
const jpeg = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbfa28a2803ffd9",
  "hex"
);

const key = `__smoke-test/${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.jpg`;

try {
  console.log("① PUT …");
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: jpeg,
    ContentType: "image/jpeg",
    ACL: "public-read",
    CacheControl: "public, max-age=31536000, immutable",
  }));
  const publicUrl = `${publicBase}/${key}`;
  console.log("   URL:", publicUrl);

  console.log("② GET (public, no token) …");
  const res = await fetch(publicUrl);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log("   status:", res.status, "bytes:", buf.length, "ct:", res.headers.get("content-type"));
  if (res.status !== 200) throw new Error(`public GET failed with ${res.status}`);

  console.log("③ DELETE …");
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  const res2 = await fetch(publicUrl);
  console.log("   after delete, public status:", res2.status, res2.status === 404 || res2.status === 403 ? "(gone ✓)" : "(check manually)");

  console.log("\n✅ Arvan OK — put/get/delete all work");
} catch (err) {
  console.error("\n❌ Arvan smoke test failed:", err.code ?? "", err.message);
  process.exit(1);
}
