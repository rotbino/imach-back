/**
 * تست سرتاسری ایمپورت اکسل — می‌سازد: preview → commit → راستی‌آزمایی لیستینگ‌ها
 * اجرا: node scripts/test-import.mjs
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

const aoa = [
  ["نام کالا", "برند", "بسته‌بندی", "قیمت", "موجودی", "حداقل سفارش"],
  ["ماکارونی", "زر", "۷۰۰ گرمی", "۵۵٬۰۰۰", "۲۴", "۱"],
  ["ماکارونی", "مکروزا", "۷۰۰ گرمی", "۵۲٬۰۰۰", "۱۸", ""],
  ["رب گوجه‌فرنگی", "چین‌چین", "۸۰۰ گرمی", "۸۹٬۰۰۰", "", ""],
  ["شیر پاستوریزه", "میهن", "۱ لیتری", "۲۸٬۰۰۰", "۳۰", "۶"],
  ["فالوده شیرازی", "", "", "۴۰٬۰۰۰", "۱۰", ""], // گودِ ناشناخته → skip
  ["عدس", "", "", "", "۵", ""], // بدون قیمت → skip (SELL)
];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Sheet1");
const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

const form = new FormData();
form.append("file", new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "list.xlsx");
form.append("businessId", bizId);
form.append("mode", "SELL");
form.append("priceUnit", "toman");

const prev = await (await fetch(`${API}/products/importPreview`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  body: form,
})).json();
console.log("── preview summary:", JSON.stringify(prev.summary));
for (const r of prev.rows) {
  console.log(`row ${r.index}: ${r.name} ${r.brand ?? ""} → ${r.matchType} (${r.productLabel ?? r.goodName ?? "—"}) warn=${r.warning ?? "-"}`);
}

const commit = await (await fetch(`${API}/products/importCommit`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    businessId: bizId,
    mode: "SELL",
    rows: prev.rows.map((r) => ({
      index: r.index, name: r.name, brand: r.brand, spec: r.spec,
      priceMinor: r.priceMinor, stock: r.stock, minOrder: r.minOrder,
    })),
  }),
})).json();
console.log("── commit:", JSON.stringify(commit));

const mine = await (await fetch(`${API}/listings/getMyListings?businessId=${bizId}`, {
  headers: { Authorization: `Bearer ${token}` },
})).json();
const mac = mine.filter((l) => l.good.nameFa === "ماکارونی");
console.log("── ماکارونی rows after import:", mac.map((l) => ({ v: l.variantLabel, pid: !!l.productId, price: l.priceMinor })));
const milk = mine.filter((l) => l.good.nameFa === "شیر پاستوریزه");
console.log("── شیر rows:", milk.map((l) => ({ v: l.variantLabel, pid: !!l.productId, price: l.priceMinor })));
