/**
 * End-to-end smoke test for the file service — against a LIVE server + real
 * Arvan bucket:
 *   register → create business → upload avatar (real S3 put) → public getUrl
 *   → direct GET from Arvan → replace semantics (old file gone) → delete
 *   → admin orphans/usage (after role flip).
 * Run with the server already listening on :4400:
 *   node scripts/test-files-e2e.mjs
 */
import { MongoClient, ObjectId } from "mongodb";
import sharp from "sharp";

const BASE = "http://127.0.0.1:4400/api/v1";
const MONGO = process.env.E2E_MONGO ?? "mongodb://127.0.0.1:27017/imach";
const PHONE = "09120000001";
const PASSWORD = "test1234";

let accessToken = null;
let passed = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) throw new Error(`❌ FAIL: ${label} ${extra}`);
  passed++;
  console.log(`✅ ${label}${extra ? ` — ${extra}` : ""}`);
};

async function api(path, { method = "GET", body, form, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// real, valid test images generated on the fly (a corrupt sample would trip
// the graceful "keep original, no thumb" path in the service)
const JPEG = await sharp({ create: { width: 900, height: 700, channels: 3, background: { r: 249, g: 115, b: 22 } } }).jpeg({ quality: 85 }).toBuffer();
const JPEG2 = await sharp({ create: { width: 700, height: 500, channels: 3, background: { r: 40, g: 40, b: 40 } } }).jpeg({ quality: 85 }).toBuffer();

try {
  // ── 0. flip the test user to ADMIN directly in mongo (for admin endpoints)
  const mc = new MongoClient(MONGO);
  await mc.connect();

  // ── 1. register (idempotent-ish: unique phone per run is fine to reuse)
  const reg = await api("/auth/registerUser", {
    method: "POST",
    auth: false,
    body: { firstName: "سعید", lastName: "تست", phone: PHONE, password: PASSWORD, country: "IR", language: "fa" },
  });
  if (reg.status !== 201 && reg.status !== 200) {
    // maybe phone taken from a previous run → login
    const login = await api("/auth/loginUser", { method: "POST", auth: false, body: { phone: PHONE, password: PASSWORD } });
    accessToken = login.data.accessToken;
  } else {
    accessToken = reg.data.accessToken;
  }
  ok("auth token", !!accessToken);

  const me = await api("/auth/getMe");
  const userId = me.data.user.id;
  ok("getMe", !!userId, userId);

  // flip to ADMIN for the admin endpoint checks
  await mc.db().collection("User").updateOne({ _id: new ObjectId(userId) }, { $set: { role: "ADMIN" } });
  await mc.close();

  // token carries role=MEMBER claims → re-login to refresh claims
  const relogin = await api("/auth/loginUser", { method: "POST", auth: false, body: { phone: PHONE, password: PASSWORD } });
  accessToken = relogin.data.accessToken;

  // ── 2. business
  const biz = await api("/businesses/createBusiness", { method: "POST", body: { name: "کاتالوگ تست", city: "تهران" } });
  ok("createBusiness", biz.status === 201 || biz.status === 200, biz.data?.slug);
  const bizId = biz.data.id;
  const slug = biz.data.slug;

  // ── 3. upload business logo (replace=true default)
  let fd = new FormData();
  fd.append("file", new Blob([JPEG], { type: "image/jpeg" }), "logo.jpg");
  const up1 = await api(`/files/upload?model=Business&modelId=${bizId}&key=logo`, { method: "POST", form: fd });
  ok("upload logo", up1.status === 201 || up1.status === 200, up1.data?.url?.slice(0, 60));
  ok("url is direct arvan", (up1.data.url ?? "").includes("arvanstorage.ir"));
  ok("thumbUrl present", !!up1.data.thumbUrl);

  // ── 4. public getUrl (no token)
  const url1 = await api(`/files/getUrl?model=Business&modelId=${bizId}&key=logo`, { auth: false });
  ok("public getUrl", url1.status === 200 && url1.data.url === up1.data.url);

  // ── 5. direct GET from Arvan (browser behaviour)
  const direct = await fetch(up1.data.url);
  ok("direct arvan GET", direct.status === 200, `${direct.status} ${(direct.headers.get("content-type") ?? "")}`);
  const thumbDirect = await fetch(up1.data.thumbUrl);
  ok("direct arvan thumb GET", thumbDirect.status === 200);

  // ── 6. replace semantics: second upload must delete the first
  fd = new FormData();
  fd.append("file", new Blob([JPEG2], { type: "image/jpeg" }), "logo2.jpg");
  const up2 = await api(`/files/upload?model=Business&modelId=${bizId}&key=logo`, { method: "POST", form: fd });
  ok("replace upload", up2.status === 201 || up2.status === 200);
  const firstUrl = up1.data.url;
  await new Promise((r) => setTimeout(r, 800));
  const firstGone = await fetch(firstUrl);
  ok("old file deleted from arvan", firstGone.status === 404 || firstGone.status === 403, `status ${firstGone.status}`);
  const list1 = await api(`/files/getList?model=Business&modelId=${bizId}&key=logo`, { auth: false });
  ok("slot has exactly 1 record", list1.data.items.length === 1, `count=${list1.data.items.length}`);

  // ── 7. gallery: append 2 images (replace=false)
  for (const name of ["a.jpg", "b.jpg"]) {
    fd = new FormData();
    fd.append("file", new Blob([JPEG], { type: "image/jpeg" }), name);
    fd.append("replace", "false");
    const up = await api(`/files/upload?model=Listing&modelId=no-listing-yet&key=gallery`, { method: "POST", form: fd });
    // invalid listing id → must 404
    ok("gallery upload on bogus listing rejected", up.status === 404, `status ${up.status}`);
    break;
  }

  // real listing: saveListing then gallery upload
  const cats = await api("/goods/getCategories", { auth: false });
  // pick the auto «سایر›جدید» path by creating a good
  const good = await api("/goods/createGood", { method: "POST", body: { name: "تست گالری" } });
  ok("createGood", good.status === 201 || good.status === 200);
  const listing = await api("/listings/saveListing", {
    method: "PUT",
    body: { businessId: bizId, goodId: good.data.id, mode: "SELL", sell: { priceMinor: 1000, stock: 5, minOrder: 1 } },
  });
  ok("saveListing", listing.status === 201 || listing.status === 200, listing.data?.id);

  fd = new FormData();
  fd.append("file", new Blob([JPEG], { type: "image/jpeg" }), "g1.jpg");
  fd.append("replace", "false");
  const g1 = await api(`/files/upload?model=Listing&modelId=${listing.data.id}&key=gallery`, { method: "POST", form: fd });
  ok("gallery upload on real listing", g1.status === 201 || g1.status === 200, g1.data?.id);

  // ── 8. public vitrine payload carries logo + gallery
  const pub = await api(`/businesses/getBusiness/${slug}`, { auth: false });
  ok("public profile has logo", !!pub.data.logo?.url);
  ok("public listing has gallery", (pub.data.listings?.[0]?.gallery ?? []).length === 1);

  // ── 9. delete the gallery file (owner flow)
  const del = await api(`/files/delete/${g1.data.id}`, { method: "DELETE" });
  ok("delete file", del.status === 200);
  const afterDel = await fetch(g1.data.url);
  ok("deleted from arvan too", afterDel.status === 404 || afterDel.status === 403, `status ${afterDel.status}`);

  // ── 10. avatar upload + remove
  fd = new FormData();
  fd.append("file", new Blob([JPEG], { type: "image/jpeg" }), "me.jpg");
  const av = await api(`/files/upload?model=User&modelId=${userId}&key=avatar`, { method: "POST", form: fd });
  ok("avatar upload", av.status === 201 || av.status === 200);
  const me2 = await api("/auth/getMe");
  ok("getMe carries avatar", !!me2.data.avatar?.url);
  const avDel = await api(`/files/delete/${av.data.id}`, { method: "DELETE" });
  ok("avatar remove", avDel.status === 200);

  // ── 11. admin surface
  const orphans = await api("/admin/files/getOrphans");
  ok("admin getOrphans", orphans.status === 200);
  const usage = await api("/admin/files/getUsage");
  ok("admin getUsage", usage.status === 200 && usage.data.items.length >= 1, JSON.stringify(usage.data.items?.[0] ?? {}).slice(0, 80));

  // ── 12. security: another (guest) cannot delete others' files
  const guard = await api(`/files/delete/${up2.data.id}`, { method: "DELETE", auth: false });
  ok("unauthenticated delete blocked", guard.status === 401 || guard.status === 403, `status ${guard.status}`);

  console.log(`\n🎉 ALL ${passed} CHECKS PASSED`);
  process.exit(0);
} catch (err) {
  console.error(err.message ?? err);
  process.exit(1);
}
