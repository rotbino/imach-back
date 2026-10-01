/*
 * Phase 8 E2E — پروفایل دو-بازویی + تنظیمات اعلان (طرح ۰۷/۱۴)
 * ۱) اندپوینت setNotifPrefs: ذخیره‌ی ادغامی + بازگشت در getMyBusinesses + گیت مالکیت
 * ۲) گیتِ «تغییر قیمت در تابلوهای من»:
 *    دیده‌بان با priceChange=false → تغییر قیمت → «هیچ» اعلان و «هیچ» مصرف پنجره‌ی روزانه
 *    روشن‌کردن → تغییر دوم → اعلان PRICE_CHANGE می‌رسد
 * ۳) دیتای پروفایل دمو: آمار واقعی (۳۸ مشتری / ۵ کالا / toggle خاموشِ طرح ۱۴)
 * ۴) پاک‌سازی کامل + ترمیم قیمت لیستینگ دموی فروشنده
 */
require("dotenv").config();
// DATABASE_URL محیط سندباکس به فایل لوکال اشاره دارد — ریپو از MONGO_URL استفاده می‌کند
if (process.env.MONGO_URL) process.env.DATABASE_URL = process.env.MONGO_URL;
const BASE = "http://127.0.0.1:4000/api/v1";
const SELLER_LOGIN = { phone: "989196421264", password: "123456" };
const TEMP_PHONE = "989120000099";

async function j(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: text }; }
}

const ok = (cond, label) => {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) process.exitCode = 1;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** پاک‌سازی اولیه — اگر اجرای قبلی وسط راه افتاده باشد، کاربر موقتِ مانده را برمی‌دارد */
async function preClean() {
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const u = await prisma.user.findFirst({ where: { phone: TEMP_PHONE }, select: { id: true } });
    if (!u) return null;
    const biz = await prisma.business.findFirst({ where: { ownerId: u.id }, select: { id: true } });
    if (biz) {
      await prisma.notification.deleteMany({ where: { userId: u.id } });
      await prisma.watchedGood.deleteMany({ where: { businessId: biz.id } });
      await prisma.page.deleteMany({ where: { businessId: biz.id } });
      await prisma.follow.deleteMany({ where: { OR: [{ followerPage: { businessId: biz.id } }, { supplierPage: { businessId: biz.id } }] } });
      await prisma.listing.deleteMany({ where: { businessId: biz.id } });
      await prisma.business.delete({ where: { id: biz.id } });
    }
    await prisma.user.delete({ where: { id: u.id } });
    console.log("  pre-clean: leftover temp user removed");
    return null;
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  await preClean();

  // ── ۱) کاربر موقت + کسب‌وکار ──
  const reg = await j("POST", "/auth/quickRegister", { phone: TEMP_PHONE, country: "98" });
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`quickRegister failed: ${JSON.stringify(reg.data).slice(0, 200)}`);
  const tempToken = reg.data.accessToken ?? reg.data.session?.accessToken;
  const tempBiz = (await j("GET", "/businesses/getMyBusinesses", null, tempToken)).data[0];
  console.log(`temp biz: ${tempBiz.name} (${tempBiz.id})`);

  // ── ۲) setNotifPrefs — ذخیره‌ی ادغامی ──
  const s1 = await j("PUT", `/businesses/setNotifPrefs/${tempBiz.id}`, { priceChange: false }, tempToken);
  ok(s1.status === 200, `setNotifPrefs 200 (got ${s1.status})`);
  ok(s1.data.priceChange === false, "پاسخ: priceChange=false");

  const mine1 = (await j("GET", "/businesses/getMyBusinesses", null, tempToken)).data[0];
  ok(mine1.notifPrefs?.priceChange === false, "getMyBusinesses: priceChange=false");
  ok(mine1.notifPrefs?.quoteReplies === undefined, "quoteReplies دست‌نخورده (merge)");

  const s2 = await j("PUT", `/businesses/setNotifPrefs/${tempBiz.id}`, { quoteReplies: true }, tempToken);
  ok(s2.data.priceChange === false && s2.data.quoteReplies === true, "merge حفظ شد: priceChange=false + quoteReplies=true");

  // گیت مالکیت: فروشنده‌ی دمو نباید بتواند تنظیمِ کاربر موقت را عوض کند
  const sellerLogin = await j("POST", "/auth/loginUser", SELLER_LOGIN);
  const sellerToken = sellerLogin.data.accessToken;
  const sellerBiz = (await j("GET", "/businesses/getMyBusinesses", null, sellerToken)).data[0];
  const s3 = await j("PUT", `/businesses/setNotifPrefs/${tempBiz.id}`, { push: false }, sellerToken);
  ok(s3.status === 403, `غیرمالک 403 (got ${s3.status})`);

  // ── ۳) گیت PRICE_CHANGE + پنجره‌ی روزانه ──
  const goods = (await j("GET", `/goods/getGoods?q=${encodeURIComponent("برنج هاشمی")}&limit=5`, null, tempToken)).data;
  const hashemi = (goods.items ?? goods)[0];

  const watch = await j("POST", "/market/watchGood", { businessId: tempBiz.id, goodId: hashemi.id }, tempToken);
  ok(watch.status === 201 || watch.status === 200, `watchGood (got ${watch.status})`);

  // قیمت اولیه‌ی لیستینگ هاشمیِ فروشنده را نگه می‌داریم
  // ⚠ GoodItemDto خودِ goodId را ندارد — از l.good.id خوانده می‌شود
  const myListings = (await j("GET", `/listings/getMyListings?businessId=${sellerBiz.id}`, null, sellerToken)).data;
  const sellerHashemi = myListings.find(
    (l) => l.good?.nameFa === "برنج هاشمی" && l.priceMinor && l.mode !== "BUY"
  );
  if (!sellerHashemi) throw new Error("seller hashemi listing not found");
  const goodId = sellerHashemi.good?.id;
  if (!goodId) throw new Error("good.id missing on listing DTO");
  const basePrice = sellerHashemi.priceMinor;
  console.log(`seller hashemi listing: ${sellerHashemi.id} · price=${basePrice} · good=${goodId}`);

  const changePrice = async (to) => {
    const r = await j(
      "PUT",
      "/listings/saveListing",
      {
        businessId: sellerBiz.id,
        goodId,
        mode: "SELL",
        listingId: sellerHashemi.id,
        sell: { priceMinor: to, stock: sellerHashemi.stock ?? 100, minOrder: sellerHashemi.minOrder ?? 1 },
      },
      sellerToken
    );
    if (r.status !== 200 && r.status !== 201)
      throw new Error(`saveListing failed (${r.status}): ${JSON.stringify(r.data).slice(0, 200)}`);
  };

  // (الف) خاموش → تغییر قیمت → هیچ اعلان، هیچ مصرف پنجره
  await changePrice(basePrice + 5000);
  await sleep(600);
  const n1 = (await j("GET", "/notifications/getNotifications", null, tempToken)).data;
  const rows1 = n1.rows ?? n1.items ?? [];
  ok(!rows1.some((r) => r.type === "PRICE_CHANGE" && r.good === "برنج هاشمی"), "خاموش: هیچ PRICE_CHANGE‌ای ساخته نشد");

  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  const w1 = await prisma.watchedGood.findFirst({
    where: { businessId: tempBiz.id, goodId: hashemi.id },
    select: { lastNotifiedAt: true },
  });
  ok(w1?.lastNotifiedAt == null, "خاموش: پنجره‌ی روزانه هم مصرف نشد");

  // (ب) روشن → تغییر دوم → اعلان می‌رسد (اگر پنجره اشتباه مصرف شده بود، اینجا نمی‌رسید)
  const s4 = await j("PUT", `/businesses/setNotifPrefs/${tempBiz.id}`, { priceChange: true }, tempToken);
  ok(s4.data.priceChange === true, "priceChange دوباره روشن شد");
  await changePrice(basePrice + 12000);
  await sleep(600);
  const n2 = (await j("GET", "/notifications/getNotifications", null, tempToken)).data;
  const rows2 = n2.rows ?? n2.items ?? [];
  const got = rows2.find((r) => r.type === "PRICE_CHANGE" && r.good === "برنج هاشمی");
  ok(!!got, "روشن: PRICE_CHANGE رسید");

  // ── ۴) دیتای پروفایل دمو (آمار واقعی) ──
  const demoMine = (await j("GET", "/businesses/getMyBusinesses", null, sellerToken)).data[0];
  ok(demoMine.notifPrefs?.priceChange === true && demoMine.notifPrefs?.quoteReplies === false,
    "دمو: toggleها مثل طرح ۱۴ (روشن/روشن/خاموش/روشن)");
  const demoListings = (await j("GET", `/listings/getMyListings?businessId=${sellerBiz.id}`, null, sellerToken)).data;
  const active = demoListings.filter((l) => l.isActive !== false && (l.mode === "SELL" || l.mode === "BOTH"));
  const views = active.reduce((s, l) => s + (l.viewCount30 ?? 0), 0);
  ok(active.length === 5 && views === 120, `آمار طرح ۰۷: ۵ کالا · ۱۲۰ بازدید (got ${active.length}/${views})`);
  const followers = (await j("GET", `/market/getFollowers?businessId=${sellerBiz.id}`, null, sellerToken)).data;
  ok(followers.length === 38, `۳۸ مشتری (got ${followers.length})`);
  const watchedQ = (await j("GET", `/market/getWatchedGoods?businessId=${sellerBiz.id}`, null, sellerToken)).data;
  ok(watchedQ.length >= 4, `لیست خرید ≥۴ کالا (got ${watchedQ.length})`);

  // ── ۵) پاک‌سازی کامل + ترمیم قیمت ──
  try {
    // قیمت فروشنده به حالت اول برگردد + PriceLog/اعلان تست پاک شود
    await prisma.listing.update({ where: { id: sellerHashemi.id }, data: { priceMinor: basePrice } });
    await prisma.priceLog.deleteMany({ where: { listingId: sellerHashemi.id, newMinor: { in: [basePrice + 5000, basePrice + 12000] } } });
    await prisma.notification.deleteMany({
      where: { type: "PRICE_CHANGE", actorId: sellerBiz.id, good: "برنج هاشمی" },
    });
    console.log("  cleanup: seller price restored + logs/notifs pruned");

    const tempUser = await prisma.user.findFirst({ where: { phone: TEMP_PHONE }, select: { id: true } });
    if (tempUser) await prisma.notification.deleteMany({ where: { userId: tempUser.id } });
    await prisma.watchedGood.deleteMany({ where: { businessId: tempBiz.id } });
    await prisma.page.deleteMany({ where: { businessId: tempBiz.id } });
    await prisma.follow.deleteMany({
      where: { OR: [{ followerPage: { businessId: tempBiz.id } }, { supplierPage: { businessId: tempBiz.id } }] },
    });
    await prisma.listing.deleteMany({ where: { businessId: tempBiz.id } });
    await prisma.business.delete({ where: { id: tempBiz.id } });
    if (tempUser) await prisma.user.delete({ where: { id: tempUser.id } });
    console.log("  cleanup: temp business + user removed");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error("TEST FAILED:", e.message); process.exit(1); });
