/*
 * Phase 6 E2E test — تابلوی تأمین + فرم درخواست قیمت (شکاف‌های ۴ و ۵)
 * ۱) کاربر موقت (quickRegister) + کسب‌وکارش
 * ۲) GET getSupplyBoard برای برنج هاشمی → ردیف‌ها + خلاصه‌ی خریدار
 * ۳) POST requestQuote با گیرنده‌ی انتخابی + شبکه → Inquiry با delivery/frequency/note
 * ۴) اعلان QUOTE برای مالک فروشنده‌ی انتخابی باید ساخته شده باشد
 * ۵) پاک‌سازی کامل با Prisma (استعلام‌ها/اعلان‌ها/کسب‌وکار/کاربر موقت)
 */
const BASE = "http://127.0.0.1:4000/api/v1";
const SELLER_LOGIN = { phone: "989196421264", password: "123456" };
const TEMP_PHONE = "989120000098";

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

async function main() {
  // ── ۱) کاربر موقت + کالای مرجع ──
  const reg = await j("POST", "/auth/quickRegister", { phone: TEMP_PHONE, country: "98" });
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`quickRegister failed: ${JSON.stringify(reg.data).slice(0, 200)}`);
  const tempToken = reg.data.accessToken ?? reg.data.session?.accessToken;
  const tempBiz = (await j("GET", "/businesses/getMyBusinesses", null, tempToken)).data[0];
  console.log(`temp biz: ${tempBiz.name} (${tempBiz.id})`);

  const goods = (await j("GET", `/goods/getGoods?q=${encodeURIComponent("برنج هاشمی")}&limit=5`, null, tempToken)).data;
  const hashemi = (goods.items ?? goods)[0];

  // ── ۲) تابلوی تأمین ──
  const board = await j("GET", `/market/getSupplyBoard?businessId=${tempBiz.id}&goodId=${hashemi.id}`, null, tempToken);
  ok(board.status === 200, `getSupplyBoard 200 (got ${board.status})`);
  const rows = board.data.rows ?? [];
  // برای کاربر تازه، همه‌ی فروشنده‌های فعال دیده می‌شوند (۳ تأمین‌کننده‌ی دمو + فروشنده‌های دیگر دیتابیس)
  ok(rows.length >= 3, `تابلوی هاشمی ≥۳ ردیف (got ${rows.length})`);
  // ردیف انزلی (تأمین‌کننده‌ی ارزانِ دمو) باید روند ▼۲٪ از ۲۹۱۰۰۰۰۰ داشته باشد
  const anzaliRow = rows.find((r) => r.seller.name.includes("انزلی"));
  ok(!!anzaliRow && anzaliRow.prevMinor === 29100000 && anzaliRow.trendPct === -2, "روند انزلی: ▼۲٪ از ۲۹۱۰۰۰۰۰");
  ok(rows.every((r) => r.sponsored === false), "sponsored فعلاً false (ساختار UI)");
  ok(board.data.watched === false, "واچ برای کاربر تازه false");

  // ── ۳) فرم درخواست قیمت — ۱ گیرنده انتخابی + شبکه ──
  // گیرنده‌ی انتخابی باید مالک داشته باشد تا اعلان QUOTE چک‌پذیر باشد
  // (انزلی و بعضی دموی‌های صحنه مالک ندارند — prop کاتالوگ‌اند، لاگین ندارند)
  const { PrismaClient } = require("@prisma/client");
  const prismaSel = new PrismaClient();
  const ownedIds = new Set(
    (
      await prismaSel.business.findMany({
        where: { id: { in: rows.map((r) => r.seller.id) }, ownerId: { not: null } },
        select: { id: true },
      })
    ).map((b) => b.id)
  );
  await prismaSel.$disconnect();
  const target = rows.find((r) => ownedIds.has(r.seller.id)) ?? rows[0];
  const rq = await j(
    "POST",
    "/market/requestQuote",
    {
      businessId: tempBiz.id,
      goodId: hashemi.id,
      volume: 15,
      frequency: "WEEKLY",
      delivery: "فوری",
      note: "تست e2e فاز ۶ — پاک می‌شود",
      supplierIds: [target.seller.id],
      includeNetwork: true,
    },
    tempToken
  );
  ok(rq.status === 201, `requestQuote 201 (got ${rq.status} ${JSON.stringify(rq.data).slice(0, 120)})`);
  ok(rq.data.created >= 1, ` Inquiry ساخته شد: ${rq.data.created} مورد`);
  ok(rq.data.networkAdded >= 1, `شبکه موتور اضافه کرد: ${rq.data.networkAdded}`);

  // درخواست ثبت‌شده با delivery/frequency/note
  const my = (await j("GET", `/market/getMyInquiries?businessId=${tempBiz.id}`, null, tempToken)).data;
  const mine = (my.rows ?? []).filter((r) => r.note === "تست e2e فاز ۶ — پاک می‌شود");
  ok(mine.length === rq.data.created, `«درخواست‌های من» ${mine.length}/${rq.data.created}`);
  const withDelivery = mine.find((r) => r.delivery === "فوری" && r.frequency === "WEEKLY" && r.volume === 15);
  ok(!!withDelivery, "Inquiry با delivery=فوری + frequency=WEEKLY + volume=15");

  // ── ۴) اعلان QUOTE برای مالکِ فروشنده‌ی «انتخابی» ──
  // نکته‌ی فاز ۸: اعلان QUOTE پشت گیت quoteReplies است — دیتای دمو طبق طرح ۱۴
  // برای پارس خاموش است؛ برای تست موقتاً روشن می‌کنیم و بعد برمی‌گردانیم.
  // چک مستقیم از DB: مالکِ خودِ فروشنده‌ی هدف (target.seller) — نه کاربر ثابت تست.
  const sellerLogin = await j("POST", "/auth/loginUser", SELLER_LOGIN);
  const sellerToken = sellerLogin.data.accessToken;
  const sellerBizId = sellerLogin.data.businesses[0].id;
  const prisma = prismaSel;
  const savedPrefs = await prisma.business.findUnique({
    where: { id: sellerBizId },
    select: { notifPrefs: true },
  });
  await j("PUT", `/businesses/setNotifPrefs/${sellerBizId}`, { quoteReplies: true }, sellerToken);
  let quoteNotif = null;
  try {
    const rq2 = await j("POST", "/market/requestQuote", {
      businessId: tempBiz.id,
      goodId: hashemi.id,
      volume: 15,
      frequency: "WEEKLY",
      delivery: "فوری",
      note: "تست e2e فاز ۶ — پاک می‌شود",
      supplierIds: [target.seller.id],
      includeNetwork: false,
    }, tempToken);
    if (rq2.status === 201) {
      const targetOwner = await prisma.business.findUnique({
        where: { id: target.seller.id },
        select: { ownerId: true },
      });
      quoteNotif = await prisma.notification.findFirst({
        where: { userId: targetOwner?.ownerId ?? "", type: "QUOTE", actorId: tempBiz.id },
        orderBy: { id: "desc" },
      });
    }
  } finally {
    const savedQr = savedPrefs && savedPrefs.notifPrefs ? savedPrefs.notifPrefs.quoteReplies : true;
    await j("PUT", `/businesses/setNotifPrefs/${sellerBizId}`, { quoteReplies: savedQr }, sellerToken);
    await prisma.$disconnect();
  }
  ok(!!quoteNotif, `اعلان QUOTE برای فروشنده‌ی انتخابی (good=${quoteNotif?.good ?? "—"})`);

  // ── ۵) پاک‌سازی کامل ──
  const prisma2 = new PrismaClient();
  try {
    const tempUser = await prisma2.user.findFirst({ where: { phone: TEMP_PHONE }, select: { id: true } });
    if (tempUser) {
      const delN = await prisma2.notification.deleteMany({ where: { userId: tempUser.id } });
      console.log(`  cleanup: ${delN.count} temp notifications`);
    }
    const delI = await prisma2.inquiry.deleteMany({
      where: { buyerId: tempBiz.id, note: "تست e2e فاز ۶ — پاک می‌شود" },
    });
    console.log(`  cleanup: ${delI.count} test inquiries`);
    // اعلان QUOTE که به مالک فروشنده رفت هم پاک شود (actor = temp biz)
    const delSellerN = await prisma2.notification.deleteMany({
      where: { type: "QUOTE", actorId: tempBiz.id },
    });
    console.log(`  cleanup: ${delSellerN.count} seller QUOTE notifications`);
    await prisma2.watchedGood.deleteMany({ where: { businessId: tempBiz.id } });
    await prisma2.page.deleteMany({ where: { businessId: tempBiz.id } });
    await prisma2.follow.deleteMany({
      where: { OR: [{ followerPage: { businessId: tempBiz.id } }, { supplierPage: { businessId: tempBiz.id } }] },
    });
    await prisma2.listing.deleteMany({ where: { businessId: tempBiz.id } });
    await prisma2.business.delete({ where: { id: tempBiz.id } });
    if (tempUser) await prisma2.user.delete({ where: { id: tempUser.id } });
    console.log("  cleanup: temp business + user removed");
  } finally {
    await prisma2.$disconnect();
  }
}

main().catch((e) => { console.error("TEST FAILED:", e.message); process.exit(1); });
