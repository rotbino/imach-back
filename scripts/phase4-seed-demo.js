/*
 * Phase 4 demo seed — درخواست‌های قیمت (design-reference/screens/05 + 06)
 *
 * نوشتن داده‌ی «واقعی» دیتابیس برای کاربر دمو 989196421264 (پخش برنج پارس):
 *   • ۳ خریدارِ طرح: رستوران مهر (تهران، تاییدشده) / پخش نگین (قزوین) / سوپرمارکت سعید (رشت)
 *   • ۴ Inquiry (۳ فعال + ۱ آرشیوشده — «۴ درخواست این ماه») + ۱ Offer (پاسخ ارسال‌شده سعید)
 *   • ۱۲ آگهی خرید روی همان گودهای برنج → موتور تطبیق «فرصت‌های بازار» را تغذیه می‌کند
 * همه‌ی ارجاع‌ها به گود/لیستینگ/کسب‌وکارهای موجودِ دیتابیس‌اند — هیچ چیز ماگ نیست.
 *
 * Ensure/Repair: هر اجرا وضعیت دمو را «درست» می‌کند — نبودها را می‌سازد و
 * انحراف‌ها (status/isRead/isActive) را ترمیم می‌کند؛ اجرای دوباره بی‌ضرر است.
 * Rollback: backups/phase4-backup-*.json (dump-db.js)
 *
 * اجرا: DATABASE_URL="$MONGO_URL" node scripts/phase4-seed-demo.js
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const SELLER_PHONE = "989196421264";
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo);

async function main() {
  // ── ۱) فروشنده‌ی دمو و لیستینگهایش ──
  const seller = await prisma.business.findFirst({
    where: { owner: { phone: SELLER_PHONE } },
    select: { id: true, name: true, slug: true, city: true, currency: true },
  });
  if (!seller) throw new Error("demo seller (989196421264) not found");
  console.log(`seller: ${seller.name} (${seller.id})`);

  const listings = await prisma.listing.findMany({
    where: { businessId: seller.id, mode: "SELL" },
    select: { id: true, priceMinor: true, currency: true, minOrder: true, isActive: true, variantLabel: true, goodId: true, good: { select: { nameFa: true } } },
  });
  const byGood = (name, variant) =>
    listings.find((l) => l.good.nameFa === name && (!variant || (l.variantLabel ?? "").includes(variant)));
  const hashemi50 = byGood("برنج هاشمی", "۵۰");
  const hashemi10 = byGood("برنج هاشمی", "۱۰");
  const tarom50 = byGood("برنج طارم", "۵۰");
  const fajr50 = byGood("برنج فجر", "۵۰");
  const sadri50 = byGood("برنج صدری", "۵۰");
  for (const [k, v] of Object.entries({ hashemi50, hashemi10, tarom50, fajr50, sadri50 })) {
    if (!v) throw new Error(`seller listing not found: ${k}`);
  }

  // ترمیم: ویترین دمو باید کامل فعال باشد (صدری خاموش = فرصت‌ها ناقص)
  if (!sadri50.isActive) {
    await prisma.listing.update({ where: { id: sadri50.id }, data: { isActive: true } });
    console.log("  ~ sadri listing re-activated");
  }

  // ── ۲) خریدارهای طرح (find-or-create) ──
  const BUYERS = [
    { name: "رستوران مهر", slug: "d-mehr-01", city: "تهران", province: "تهران", trade: "رستوران و فست‌فود", isVerified: true, phone: "02188776655" },
    { name: "پخش نگین", slug: "d-negin-02", city: "قزوین", province: "قزوین", trade: "پخش مواد غذایی", isVerified: false, phone: "02833334455" },
    { name: "سوپرمارکت سعید", slug: "d-saeed-03", city: "رشت", province: "گیلان", trade: "سوپرمارکت", isVerified: false, phone: "01344445566" },
  ];
  const buyerIds = {};
  for (const b of BUYERS) {
    let biz = await prisma.business.findFirst({ where: { name: b.name }, select: { id: true } });
    if (!biz) {
      biz = await prisma.business.create({
        data: { slug: b.slug, name: b.name, city: b.city, province: b.province, trade: b.trade, isVerified: b.isVerified, phone: b.phone, isDemo: true },
        select: { id: true },
      });
      for (const type of ["SELL", "BUY"]) {
        await prisma.page.create({ data: { businessId: biz.id, type } });
      }
      console.log(`  + buyer created: ${b.name} (${b.city})`);
    } else {
      console.log(`  = buyer exists: ${b.name}`);
    }
    buyerIds[b.name] = biz.id;
  }
  let navid = await prisma.business.findFirst({ where: { name: "بقالی نوید" }, select: { id: true } });
  if (!navid) {
    navid = await prisma.business.create({
      data: { slug: "d-navid-04", name: "بقالی نوید", city: "رشت", province: "گیلان", trade: "بقالی", isDemo: true },
      select: { id: true },
    });
    for (const type of ["SELL", "BUY"]) await prisma.page.create({ data: { businessId: navid.id, type } });
  }

  // ── ۳) درخواست‌های قیمت — ensure/repair (طرح ۰۵: ۳ فعال + ۱ آرشیو) ──
  const INQ = [
    {
      buyerId: buyerIds["رستوران مهر"],
      listingId: hashemi50.id,
      volume: 20,
      frequency: "MONTHLY",
      delivery: "این ماه",
      note: "با احترام، تحویل تهران منطقه ۵، پنج‌شنبه‌ها صبح. اگر بوجار درجه یک دارید ممنون می‌شوم قیمت و شرایط ارسال بفرمایید.",
      status: "NEW",
      isRead: false,
      createdAt: iso(2 * DAY - 2 * 60 * 60 * 1000),
    },
    {
      buyerId: buyerIds["پخش نگین"],
      listingId: tarom50.id,
      volume: 30,
      frequency: "MONTHLY",
      note: null,
      status: "NEW",
      isRead: true,
      createdAt: iso(2 * DAY),
    },
    {
      buyerId: buyerIds["سوپرمارکت سعید"],
      listingId: fajr50.id,
      volume: 10,
      status: "ANSWERED",
      isRead: true,
      createdAt: iso(5 * DAY),
    },
    {
      buyerId: navid.id,
      listingId: hashemi10.id,
      volume: 8,
      status: "ARCHIVED",
      isRead: true,
      createdAt: iso(3 * DAY),
    },
  ];
  let inqFixed = 0;
  for (const spec of INQ) {
    const found = await prisma.inquiry.findFirst({
      where: { sellerId: seller.id, buyerId: spec.buyerId, listingId: spec.listingId, volume: spec.volume },
      select: { id: true, status: true, isRead: true },
    });
    if (!found) {
      await prisma.inquiry.create({ data: { ...spec, sellerId: seller.id } });
      inqFixed++;
    } else {
      // ترمیم انحراف‌ها (مثلاً هم‌زمانیِ sandboxهای موازی)
      const drift =
        found.status !== spec.status ||
        found.isRead !== spec.isRead;
      if (drift) {
        await prisma.inquiry.update({
          where: { id: found.id },
          data: { status: spec.status, isRead: spec.isRead },
        });
        inqFixed++;
      }
    }
  }
  console.log(`  ~ inquiries ensured (${inqFixed} written/repaired)`);

  // پاسخِ ارسال‌شده برای سعید — درخواست «پاسخ داده‌شده» باید پیشنهاد واقعی داشته باشد
  const saeedInq = await prisma.inquiry.findFirst({
    where: { sellerId: seller.id, buyerId: buyerIds["سوپرمارکت سعید"], listingId: fajr50.id, volume: 10 },
    select: { id: true },
  });
  const offerExists = await prisma.offer.findFirst({
    where: { sellerId: seller.id, buyerId: buyerIds["سوپرمارکت سعید"], listingId: fajr50.id },
    select: { id: true },
  });
  if (saeedInq && !offerExists) {
    await prisma.offer.create({
      data: {
        buyerId: buyerIds["سوپرمارکت سعید"],
        sellerId: seller.id,
        listingId: fajr50.id,
        priceMinor: 24500000, // ۲٬۴۵۰٬۰۰۰ تومان — زیر قیمت کاتالوگ (۲۴۸)
        currency: "IRR",
        minOrder: fajr50.minOrder ?? 2,
        score: 0,
        isSpecial: false,
        note: "موجودی آماده — ارسال روزانه از رشت",
        createdAt: iso(5 * DAY - 3 * 60 * 60 * 1000),
      },
    });
    console.log("  + answered offer (re)created");
  }

  // ── ۴) فرصت‌های بازار — ۱۲ آگهی خرید روی گودهای برنج (ensure) ──
  const OPPS = [
    { name: "طعمِ رشت", good: "hashemi", volume: 30, frequency: "MONTHLY", city: "رشت", province: "گیلان", hoursAgo: 5 },
    { name: "سوپرمارکت شهرک غرب", good: "hashemi", volume: 80, frequency: "MONTHLY", city: "رشت", province: "گیلان", hoursAgo: 11 },
    { name: "رستوران دریاکنار", good: "hashemi", volume: 25, frequency: "WEEKLY", city: "رشت", province: "گیلان", hoursAgo: 20 },
    { name: "فروشگاه مواد غذایی سپید", good: "hashemi", volume: 60, frequency: "MONTHLY", city: "رشت", province: "گیلان", hoursAgo: 30 },
    { name: "سوپرمارکت ماهان", good: "tarom", volume: 90, frequency: "MONTHLY", city: "رشت", province: "گیلان", hoursAgo: 8 },
    { name: "کترینگ دانشگاه گیلان", good: "tarom", volume: 40, frequency: "MONTHLY", city: "رشت", province: "گیلان", hoursAgo: 16 },
    { name: "بازار سنتی لاهیجان", good: "tarom", volume: 50, frequency: "OCCASIONAL", city: "لاهیجان", province: "گیلان", hoursAgo: 26 },
    { name: "قنادی نایل", good: "tarom", volume: 12, frequency: "MONTHLY", city: "تهران", province: "تهران", hoursAgo: 36 },
    { name: "سوپرمارکت رفاه", good: "fajr", volume: 120, frequency: "MONTHLY", city: "تهران", province: "تهران", hoursAgo: 7 },
    { name: "هتل رستوران نفت", good: "fajr", volume: 45, frequency: "MONTHLY", city: "بندر انزلی", province: "گیلان", hoursAgo: 18 },
    { name: "فروشگاه خانگی", good: "sadri", volume: 70, frequency: "MONTHLY", city: "بندر انزلی", province: "گیلان", hoursAgo: 14 },
    { name: "سوپرمارکت شهروند", good: "sadri", volume: 100, frequency: "MONTHLY", city: "تهران", province: "تهران", hoursAgo: 28 },
  ];
  const goodIdOf = { hashemi: hashemi50.goodId, tarom: tarom50.goodId, fajr: fajr50.goodId, sadri: sadri50.goodId };
  const existingOpps = await prisma.listing.findMany({
    where: { mode: "BUY", businessId: { not: seller.id }, goodId: { in: Object.values(goodIdOf) } },
    select: { businessId: true, goodId: true, volume: true },
  });
  const oppKey = (biz, good, vol) => `${biz}:${good}:${vol}`;
  const existingKeys = new Set(existingOpps.map((o) => oppKey(o.businessId, o.goodId, o.volume)));
  let oppsCreated = 0;
  for (const o of OPPS) {
    const biz = await prisma.business.findFirst({ where: { name: o.name }, select: { id: true } });
    if (!biz) {
      console.log(`  ! skip: business «${o.name}» not found`);
      continue;
    }
    if (existingKeys.has(oppKey(biz.id, goodIdOf[o.good], o.volume))) continue;
    await prisma.listing.create({
      data: {
        businessId: biz.id,
        goodId: goodIdOf[o.good],
        mode: "BUY",
        volume: o.volume,
        frequency: o.frequency,
        isActive: true,
        city: o.city,
        province: o.province,
        country: "IR",
        updatedAt: iso(o.hoursAgo * 60 * 60 * 1000),
      },
    });
    oppsCreated++;
  }
  console.log(`  ~ opportunities ensured (${oppsCreated} created)`);

  // ── ۵) راستی‌آزمایی ──
  const [inq, activeInq, unread, opp, offers] = await Promise.all([
    prisma.inquiry.count({ where: { sellerId: seller.id } }),
    prisma.inquiry.count({ where: { sellerId: seller.id, status: { not: "ARCHIVED" } } }),
    prisma.inquiry.count({ where: { sellerId: seller.id, isRead: false } }),
    prisma.listing.count({ where: { mode: "BUY", businessId: { not: seller.id } } }),
    prisma.offer.count({ where: { sellerId: seller.id } }),
  ]);
  console.log(
    `\nVERIFY: inquiries=${inq} (expect 4) | active=${activeInq} (expect 3) | unread=${unread} (expect 1) | opportunities=${opp} (expect 12) | offers=${offers} (expect 1)`
  );
}

main()
  .catch((e) => {
    console.error("SEED FAILED:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
