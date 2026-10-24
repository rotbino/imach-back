#!/usr/bin/env node
/**
 * iMach — M2 e2e: Listing v2 contract on the REAL backend
 * ------------------------------------------------------------
 * Covers (against a live server, real Atlas DB):
 *   1. quickRegister a throwaway seller (TR) → business
 *   2. saveListing v2 with title/note/baseQty → pricePerBaseMinor computed
 *   3. re-save with SAME price → pricedAt must NOT move (no renew on edit)
 *   4. bulkPriceStock: pct change + renew-only item
 *   5. catalogSettings: priceVisibilityTrades + priceValidityDays (1..5)
 *   6. getBusiness/:slug public → priceExpired badge logic
 *   7. cleanup: deleteMe
 *
 * Usage: node scripts/m2-e2e.cjs [baseUrl]
 */
const BASE = process.argv[2] || "http://localhost:4010/api/v1";

let cookie = "";
let accessToken = "";
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  if (json?.accessToken) accessToken = json.accessToken;
  return { status: res.status, json };
}

const fail = (msg) => { console.error(`✖ ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`✔ ${msg}`);

(async () => {
  // ── 1. throwaway seller ──
  const phone = `90${Date.now()}`.slice(0, 12);
  let r = await api("POST", "/auth/quickRegister", { phone, country: "TR" });
  if (r.status !== 201 && r.status !== 200) fail(`quickRegister ${r.status} ${JSON.stringify(r.json)}`);
  const user = r.json.user ?? r.json;
  const businesses = r.json.businesses ?? [];
  if (businesses.length < 1) fail("no placeholder business");
  const biz = businesses[0];
  ok(`seller registered (${phone}) → biz ${biz.id}`);

  // find a Good to list — getGoods (authed) or search
  r = await api("GET", "/goods/getGoods?limit=5");
  if (r.status !== 200 || !r.json?.items?.length) fail(`getGoods ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  const good = r.json.items.find((g) => g.unit === "KILOGRAM") ?? r.json.items[0];
  ok(`good picked: ${good.nameFa} (${good.id}) unit=${good.unit}`);

  // ── 2. saveListing v2 ──
  const PRICE = 28_500_000; // «کیسهٔ ۵۰ کیلویی» → ۵۷۰٬۰۰۰ بر کیلو
  r = await api("PUT", "/listings/saveListing", {
    businessId: biz.id,
    goodId: good.id,
    mode: "SELL",
    title: "برنج تست M2 — بسته ویژه",
    note: "تحویل از انبار تست",
    baseQty: 50,
    sell: { priceMinor: PRICE, stock: 120, minOrder: 2 },
  });
  if (r.status !== 201 && r.status !== 200) fail(`saveListing ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  const L1 = r.json;
  if (L1.baseQty !== 50) fail(`baseQty ${L1.baseQty} !== 50`);
  if (L1.pricePerBaseMinor !== 570000) fail(`pricePerBaseMinor ${L1.pricePerBaseMinor} !== 570000`);
  if (L1.title !== "برنج تست M2 — بسته ویژه") fail(`title ${L1.title}`);
  if (L1.note !== "تحویل از انبار تست") fail(`note ${L1.note}`);
  if (!L1.pricedAt) fail("pricedAt missing on first price");
  ok(`saveListing v2: baseQty=50 · pricePerBase=570,000 · title/note saved · pricedAt=${L1.pricedAt}`);

  // ── 3. re-save SAME price (edit stock only) → pricedAt must NOT move ──
  await new Promise((res) => setTimeout(res, 1200));
  r = await api("PUT", "/listings/saveListing", {
    businessId: biz.id,
    goodId: good.id,
    listingId: L1.id,
    mode: "SELL",
    title: "برنج تست M2 — بسته ویژه",
    baseQty: 50,
    sell: { priceMinor: PRICE, stock: 90, minOrder: 2 },
  });
  if (r.status !== 200) fail(`re-save ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  if (new Date(r.json.pricedAt).getTime() !== new Date(L1.pricedAt).getTime()) {
    fail(`pricedAt moved on same-price edit: ${L1.pricedAt} → ${r.json.pricedAt}`);
  }
  ok("same-price edit: pricedAt untouched (stock-only edit does not renew validity)");

  // ── 4. bulkPriceStock: pct −10% + renew-only ──
  r = await api("PUT", "/listings/bulkPriceStock", {
    businessId: biz.id,
    items: [{ listingId: L1.id, pct: -10 }],
  });
  if (r.status !== 201 && r.status !== 200) fail(`bulkPriceStock ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  const afterPct = r.json.items[0];
  const expect = Math.round(PRICE * 0.9);
  if (afterPct.priceMinor !== expect) fail(`pct price ${afterPct.priceMinor} !== ${expect}`);
  if (afterPct.priceMinor === PRICE) fail("pct did not change price");
  ok(`bulkPriceStock pct −10%: ${PRICE} → ${afterPct.priceMinor}`);

  // renew-only (تمدید سریع)
  const t1 = new Date(afterPct.priceMinor ? Date.now() : 0);
  await new Promise((res) => setTimeout(res, 1100));
  r = await api("PUT", "/listings/bulkPriceStock", {
    businessId: biz.id,
    items: [{ listingId: L1.id }],
  });
  if (r.status !== 200 && r.status !== 201) fail(`renew ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  if (r.json.updated !== 1) fail(`renew updated=${r.json.updated}`);
  ok("bulkPriceStock renew-only: updated=1 (تمدید سریع)");

  // ── 5. catalogSettings ──
  r = await api("PUT", `/businesses/catalogSettings/${biz.id}`, {
    priceVisibilityTrades: ["سوپرمارکت", "رستوران"],
    priceValidityDays: 3,
  });
  if (r.status !== 201 && r.status !== 200) fail(`catalogSettings ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  if (JSON.stringify(r.json.priceVisibilityTrades) !== JSON.stringify(["سوپرمارکت", "رستوران"])) fail(`trades ${JSON.stringify(r.json.priceVisibilityTrades)}`);
  if (r.json.priceValidityDays !== 3) fail(`validity ${r.json.priceValidityDays}`);
  ok("catalogSettings: trades=[سوپرمارکت,رستوران] · validity=3d");

  // invalid: 7 days must 400
  r = await api("PUT", `/businesses/catalogSettings/${biz.id}`, { priceValidityDays: 7 });
  if (r.status !== 400) fail(`validity=7 should 400, got ${r.status}`);
  ok("catalogSettings guard: validity=7 → 400");

  // clear trades (null = همه می‌بینند)
  r = await api("PUT", `/businesses/catalogSettings/${biz.id}`, { priceVisibilityTrades: null });
  if (r.status !== 200 && r.status !== 201) fail(`clear trades ${r.status}`);
  if (r.json.priceVisibilityTrades !== null) fail(`trades not null: ${JSON.stringify(r.json.priceVisibilityTrades)}`);
  ok("catalogSettings clear: trades → null (همه می‌بینند)");

  // ── 6. public getBusiness/:slug → priceExpired=false (priced just now) ──
  r = await api("GET", `/businesses/getBusiness/${biz.slug}`);
  if (r.status !== 200) fail(`getBusiness ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  const pub = r.json.listings?.find((l) => l.id === L1.id);
  if (!pub) fail("listing missing in public view");
  if (pub.priceExpired !== false) fail(`priceExpired ${pub.priceExpired} !== false (fresh price)`);
  if (pub.title !== "برنج تست M2 — بسته ویژه") fail(`public title ${pub.title}`);
  ok(`public getBusiness: title + priceExpired=false (fresh) · priceMinor visible`);

  // ── 7. cleanup ──
  r = await api("POST", "/auth/deleteMe");
  if (r.status !== 200 && r.status !== 204) fail(`deleteMe ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  ok("cleanup: deleteMe — throwaway seller gone (listing cascades)");

  console.log("\nALL M2 E2E PASS ✅");
})().catch((e) => { console.error("✖ crash:", e); process.exit(1); });
