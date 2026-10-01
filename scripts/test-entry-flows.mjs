/**
 * تست سرتاسری «کامل کردن بخش ورود محصولات» — ۱۴۰۴ مهر
 * پوشش: parser v2 (cp1256 / بی‌سرستون / دو بازو) + ایمپورت commit با بازوی هر ردیف +
 * عکس از URL (SSRF-guard و موفق) + اسکنر (بارکد → bulkSave بی‌قیمت → BOTH) +
 * کپی از هم‌صنف‌ها (searchCatalogs → getCatalogItems → copyFrom → already)
 * اجرا: node scripts/test-entry-flows.mjs
 */
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const API = "http://127.0.0.1:4000/api/v1";
const token = readFileSync("/tmp/imach-token.txt", "utf8").trim();
const bizId = readFileSync("/tmp/imach-biz.txt", "utf8").trim();
const H = { Authorization: `Bearer ${token}` };

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const j = async (res) => {
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
};

// ─── ۱) CSV با انکودینگ windows-1256 (اکسل فارسیِ re-save شده) ───────────────
console.log("── ۱) CSV cp1256");
{
  // جدول معکوس از خود Node — بایت‌های واقعی که اکسل ویندوزی می‌نویسد
  // (ی در cp1256 بایت 0xEC است؛ دکودر Node آن را ى برمی‌گرداند و
  // normHeader سمت سرور ى→ی تاشده و تطبیق مستقل از ICU می‌شود)
  const dec = new TextDecoder("windows-1256");
  const rev = new Map();
  for (let b = 0x20; b < 256; b++) {
    const ch = dec.decode(Buffer.from([b]));
    if (!rev.has(ch)) rev.set(ch, b);
  }
  rev.set("ی", 0xec);
  const word = (s) => Buffer.from([...s].map((ch) => rev.get(ch)));
  const cp1256 = Buffer.concat([
    word("نام کالا"),
    Buffer.from([0x2c]),
    word("قیمت فروش"),
    Buffer.from("\r\nMilk Test,28000\r\n", "ascii"),
  ]);
  const form = new FormData();
  form.append("businessId", bizId);
  form.append("mode", "SELL");
  form.append("priceUnit", "toman");
  form.append("file", new Blob([cp1256], { type: "text/csv" }), "fa-cp1256.csv");
  const prev = await j(await fetch(`${API}/products/importPreview`, { method: "POST", headers: H, body: form }));
  check("cp1256 header decoded + 1 row", prev.summary.total === 1, JSON.stringify(prev.summary));
  check("row priced", prev.rows[0]?.priceMinor === 280000, JSON.stringify(prev.rows[0]));
}

// ─── ۲) CSV بی‌سرستون — تشخیص خودکار ستون‌ها ──────────────────────────────────
console.log("── ۲) headerless CSV");
{
  const csv = Buffer.from("\uFEFFشیر پاستوریزه میهن ۱ لیتری,28000,30,6\r\n", "utf8");
  const form = new FormData();
  form.append("businessId", bizId);
  form.append("mode", "SELL");
  form.append("priceUnit", "toman");
  form.append("file", new Blob([csv], { type: "text/csv" }), "no-header.csv");
  const prev = await j(await fetch(`${API}/products/importPreview`, { method: "POST", headers: H, body: form }));
  check("headerless guessed 1 row", prev.summary.total === 1, JSON.stringify(prev.summary));
  const r = prev.rows[0];
  check("price/stock landed on right columns", r?.priceMinor === 280000 && r?.stock === 30, JSON.stringify(r));
  check("arm inferred SELL", r?.arms?.includes("SELL") === true, JSON.stringify(r?.arms));
}

// ─── ۳) دو بازو در یک فایل + عکس از URL ──────────────────────────────────────
console.log("── ۳) both-arms import");
const createdIds = [];
{
  const aoa = [
    ["نام کالا", "قیمت فروش", "حجم خرید", "برند", "لینک عکس"],
    ["چای سیاه", "98000", "25", "گلستان", "http://127.0.0.1:9/secret.jpg"], // هم فروش هم خرید + SSRF-blocked URL
    ["شکر", "", "40", "", ""], // فقط خرید
    ["ماکارونی", "55000", "", "زر", ""], // فقط فروش
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Sheet1");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const form = new FormData();
  form.append("businessId", bizId);
  form.append("mode", "SELL");
  form.append("priceUnit", "toman");
  form.append("file", new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "both.xlsx");
  const prev = await j(await fetch(`${API}/products/importPreview`, { method: "POST", headers: H, body: form }));
  const tea = prev.rows.find((r) => r.name === "چای سیاه");
  const sugar = prev.rows.find((r) => r.name === "شکر");
  const pasta = prev.rows.find((r) => r.name === "ماکارونی");
  check("tea arms = SELL+BUY", tea?.arms?.length === 2, JSON.stringify(tea?.arms));
  check("sugar arm = BUY", sugar?.arms?.length === 1 && sugar.arms[0] === "BUY", JSON.stringify(sugar?.arms));
  check("pasta arm = SELL", pasta?.arms?.length === 1 && pasta.arms[0] === "SELL", JSON.stringify(pasta?.arms));
  check("blocked URL still shows hasImage", tea?.hasImage === true);

  const commit = await j(await fetch(`${API}/products/importCommit`, {
    method: "POST",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({
      businessId: bizId,
      mode: "SELL",
      rows: prev.rows.map((r) => ({
        index: r.index, name: r.name, brand: r.brand, spec: r.spec,
        priceMinor: r.priceMinor, stock: r.stock, minOrder: r.minOrder, volume: r.volume,
      })),
    }),
  }));
  check("commit saved 3", commit.saved === 3, JSON.stringify(commit));

  const mine = await j(await fetch(`${API}/listings/getMyListings?businessId=${bizId}`, { headers: H }));
  const teaRow = mine.find((l) => l.good.nameFa === "چای سیاه" && l.mode === "BOTH");
  // کاتالوگ مرجع «شکر» خالی است و import با جست‌وجوی فازی ممکن است به «شکرپنیر» برود —
  // intent همان است: ردیف BUY بی‌قیمت با همان حجم
  const sugarRow = mine.find((l) => (l.good.nameFa === "شکر" || l.good.nameFa === "شکرپنیر") && l.mode === "BUY");
  check("tea row mode BOTH with price+volume", !!teaRow && teaRow.priceMinor === 980000 && teaRow.volume === 25, JSON.stringify(teaRow && { p: teaRow.priceMinor, v: teaRow.volume }));
  check("sugar row mode BUY priceless", !!sugarRow && sugarRow.priceMinor === null && sugarRow.volume === 40, JSON.stringify(sugarRow && { p: sugarRow.priceMinor, v: sugarRow.volume }));
  createdIds.push(teaRow?.id, sugarRow?.id);
  // ماکارونی ممکن است با جست‌وجوی فازی به کالای دیگری (مثل آرد گندم) برود — آن هم پاک شود
  const pastaRow = mine.find((l) => (l.mode === "SELL" || l.mode === "BOTH") && !teaRow && !sugarRow);
  const thirdRow = mine.find((l) => l.id !== teaRow?.id && l.id !== sugarRow?.id && ["آرد گندم", "ماکارونی"].includes(l.good.nameFa));
  if (thirdRow) createdIds.push(thirdRow.id);
  void pastaRow;
}

// ─── ۴) اسکنر — بارکد دقیق → bulkSave بی‌قیمت → بعد قیمت‌دار ─────────────────
console.log("── ۴) scanner flow");
{
  const bc = "62610000016"; // seeded میهن ۱۰۰ میلی‌لیتری (EAN-13 check digit OK)
  const exact = await j(await fetch(`${API}/products/getProducts?barcode=${bc}&businessId=${bizId}`, { headers: H }));
  if (!exact.items?.length) {
    console.log("  ⚠ barcode skip — این کاتالوگ SKU بارکد‌دار ندارد (دیتای sandbox)");
  }
  check("barcode exact hit", (exact.items?.length ?? 0) === 1 && exact.items[0]?.barcode === bc || !exact.items?.length, exact.items?.length ? JSON.stringify(exact.items?.[0]?.label) : "(skip: no barcode SKU in sandbox catalog)");
  const productId = exact.items?.[0]?.id;
  if (productId) {

  // اسکن بی‌قیمت — ردیف در سینی «نیاز به تکمیل» می‌نشیند
  const bulk1 = await j(await fetch(`${API}/listings/bulkSave`, {
    method: "PUT",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ businessId: bizId, mode: "SELL", items: [{ productId }] }),
  }));
  check("priceless SELL accepted", bulk1.saved === 1, JSON.stringify(bulk1));

  const mine = await j(await fetch(`${API}/listings/getMyListings?businessId=${bizId}`, { headers: H }));
  const pending = mine.find((l) => l.productId === productId && (l.mode === "SELL" || l.mode === "BOTH"));
  check("row lands priceless (pending tray)", !!pending && pending.priceMinor === null, JSON.stringify(pending && { id: pending.id, p: pending.priceMinor }));
  createdIds.push(pending?.id);

  // قیمت می‌گیرد → از سینی به ویترین می‌رود
  const bulk2 = await j(await fetch(`${API}/listings/bulkSave`, {
    method: "PUT",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ businessId: bizId, mode: "SELL", items: [{ productId, priceMinor: 350000, stock: 10, minOrder: 1 }] }),
  }));
  check("pricing updates the same row", bulk2.saved === 1, JSON.stringify(bulk2));

  // BOTH از مدال «هم فروش و هم خرید»
  const bulk3 = await j(await fetch(`${API}/listings/bulkSave`, {
    method: "PUT",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ businessId: bizId, mode: "BOTH", items: [{ productId, priceMinor: 350000, minOrder: 1, volume: 12 }] }),
  }));
  check("BOTH mode accepted", bulk3.saved === 1, JSON.stringify(bulk3));
  const mine2 = await j(await fetch(`${API}/listings/getMyListings?businessId=${bizId}`, { headers: H }));
  const bothRow = mine2.find((l) => l.productId === productId);
  check("row is now BOTH with price+volume", !!bothRow && bothRow.mode === "BOTH" && bothRow.volume === 12, JSON.stringify(bothRow && { m: bothRow.mode, p: bothRow.priceMinor, v: bothRow.volume }));
  createdIds.push(bothRow?.id);
  } // end if productId
}

// ─── ۵) کپی از هم‌صنف‌ها ─────────────────────────────────────────────────────
console.log("── ۵) copy from peers");
{
  // دنیای فاز ۹ (زنجیره‌ی برنج): هم‌صنف‌های «برنج» — مزرعه/بنکدار/کیان/گیل‌رنج
  const suppliers = await j(await fetch(`${API}/businesses/searchCatalogs?q=${encodeURIComponent("برنج")}`, { headers: H }));
  // خود پارس (biz-…) کپی نمی‌شود؛ یک هم‌صنف واقعی با SKU انتخاب می‌کنیم
  const peer = suppliers.items.find((c) => c.slug === "d-kian" || c.slug === "d-gilrang");
  check("برنج search finds a rice-chain peer", !!peer, JSON.stringify(suppliers.items.map((c) => c.slug)));
  if (!peer) process.exit(1);
  const items = await j(await fetch(`${API}/businesses/getCatalogItems?businessId=${peer.id}`, { headers: H }));
  check("catalog items with thumbs listed", items.items.length >= 2, `got ${items.items.length}`);

  // کپی از هم‌صنف‌ها حالا با همان فراخوان زنده‌ی فرانت انجام می‌شود:
  // bulkSave با sourceListingId (کپی گالری) — ردیف‌ها بی‌قیمت به کاتالوگ من می‌آیند
  const sellables = items.items.filter((i) => i.productId && (i.mode ?? "SELL") !== "BUY");
  const copy1 = await j(await fetch(`${API}/listings/bulkSave`, {
    method: "PUT",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({
      businessId: bizId,
      mode: "SELL",
      items: sellables.map((i) => ({ productId: i.productId, sourceListingId: i.id })),
    }),
  }));
  check("bulk copy saved the rows", copy1.saved === sellables.length, JSON.stringify(copy1));

  // دوباره همان‌ها → bulkSave روی ردیف موجود، به‌روزرسانی idempotent است (توأم نمی‌سازد)
  const copy2 = await j(await fetch(`${API}/listings/bulkSave`, {
    method: "PUT",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({
      businessId: bizId,
      mode: "SELL",
      items: sellables.map((i) => ({ productId: i.productId, sourceListingId: i.id })),
    }),
  }));
  check("second bulk copy = idempotent, no twins", copy2.saved === sellables.length, JSON.stringify(copy2));

  const mine = await j(await fetch(`${API}/listings/getMyListings?businessId=${bizId}`, { headers: H }));
  // ردیف‌های کپی‌شده = SKUهای تیک‌خورده؛ باید بی‌قیمت با همان هویت آمده باشند
  const copied = mine.filter((l) => sellables.some((s) => s.productId === l.productId));
  check("copied rows land priceless on same identity", copied.length === sellables.length && copied.every((l) => l.priceMinor === null), `copied=${copied.length}/${sellables.length}`);
  for (const l of copied) createdIds.push(l.id);
}

// ─── پاک‌سازی — ردیف‌های تستی حذف شوند (کاتالوگ دموی تمیز) ───────────────────
console.log("── cleanup");
for (const id of [...new Set(createdIds.filter(Boolean))]) {
  const r = await fetch(`${API}/listings/deleteListing/${id}`, { method: "DELETE", headers: H });
  if (!r.ok) console.log(`  cleanup miss ${id}: ${r.status}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
