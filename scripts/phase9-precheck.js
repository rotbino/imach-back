/*
 * Phase 9 pre-check — نمای کامل دیتای دمو برای بازسازی زنجیره‌ی برنج
 * فقط خواندن. اجرا: node scripts/phase9-precheck.js
 */
require("dotenv").config();
if (process.env.MONGO_URL) process.env.DATABASE_URL = process.env.MONGO_URL;
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  // همه‌ی بیزینس‌ها + مالک + تعداد آگهی
  const bizs = await prisma.business.findMany({
    select: {
      id: true, name: true, slug: true, city: true, trade: true, isDemo: true, isVerified: true,
      owner: { select: { phone: true, name: true, passwordSet: true } },
      _count: { select: { listings: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  console.log(`=== BUSINESSES (${bizs.length}) ===`);
  for (const b of bizs)
    console.log(
      `${b.name} | ${b.city} | trade=${b.trade ?? "-"} | demo=${b.isDemo} | ver=${b.isVerified} | owner=${b.owner?.phone ?? "NO-OWNER"} pwSet=${b.owner?.passwordSet} | listings=${b._count.listings}`
    );

  // لیستینگ‌های هر بیزینس دمو (برای شناسایی سوپرمارکت‌ها)
  console.log(`\n=== DEMO LISTINGS ===`);
  const demoBizs = bizs.filter((b) => b.owner); // با مالک
  for (const b of demoBizs) {
    const ls = await prisma.listing.findMany({
      where: { businessId: b.id },
      select: { mode: true, isActive: true, priceMinor: true, volume: true, frequency: true, good: { select: { nameFa: true } } },
    });
    if (ls.length === 0) continue;
    console.log(`\n-- ${b.name} (${b.trade ?? "-"}):`);
    for (const l of ls)
      console.log(
        `   ${l.mode}${l.isActive ? "" : "(off)"} ${l.good.nameFa} price=${l.priceMinor ?? "-"} vol=${l.volume ?? "-"} ${l.frequency ?? ""}`
      );
  }

  // کالاهای برنج و غذا
  console.log(`\n=== GOODS (برنج/غذا) ===`);
  const goods = await prisma.good.findMany({
    where: { OR: [{ nameFa: { contains: "برنج" } }, { nameFa: { contains: "چلو" } }, { nameFa: { contains: "کباب" } }] },
    select: { id: true, nameFa: true, unit: true, category: { select: { nameFa: true, slug: true } } },
  });
  for (const g of goods) console.log(`${g.id} ${g.nameFa} (${g.unit}) | cat=${g.category?.nameFa} (${g.category?.slug})`);

  // روابط شبکه دمو: فالو / استعلام / واچ
  console.log(`\n=== FOLLOWS ===`);
  const follows = await prisma.follow.findMany({
    select: { followerPage: { select: { business: { select: { name: true } }, type: true } }, supplierPage: { select: { business: { select: { name: true } }, type: true } } },
  });
  for (const f of follows)
    console.log(`${f.followerPage.business.name}(${f.followerPage.type}) → ${f.supplierPage.business.name}(${f.supplierPage.type})`);

  console.log(`\n=== INQUIRIES ===`);
  const inqs = await prisma.inquiry.findMany({
    select: { id: true, status: true, buyer: { select: { name: true } }, seller: { select: { name: true } }, listing: { select: { good: { select: { nameFa: true } } } } },
  });
  const offers = await prisma.offer.findMany({ select: { listingId: true, sellerId: true, buyerId: true, priceMinor: true, score: true } });
  for (const i of inqs) {
    const cnt = offers.filter((o) => o.listingId === i.listingId && o.sellerId === i.sellerId).length;
    console.log(`${i.buyer.name} → ${i.seller.name} · ${i.listing?.good?.nameFa} · ${i.status} · offers=${cnt}`);
  }
  console.log(`OFFERS total=${offers.length}`);
  for (const o of offers) console.log(`  offer: buyer=${o.buyerId} seller=${o.sellerId} price=${o.priceMinor} score=${o.score}`);

  console.log(`\n=== WATCHED ===`);
  const watched = await prisma.watchedGood.findMany({
    select: { business: { select: { name: true } }, good: { select: { nameFa: true } } },
  });
  for (const w of watched) console.log(`${w.business.name}: ${w.good.nameFa}`);

  console.log(`\n=== PRICELOG ===`);
  const logs = await prisma.priceLog.findMany({
    select: { listing: { select: { business: { select: { name: true } }, good: { select: { nameFa: true } } } }, oldMinor: true, newMinor: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  for (const l of logs)
    console.log(`${l.listing.business.name} · ${l.listing.good.nameFa} · ${l.oldMinor}→${l.newMinor} · ${l.createdAt.toISOString().slice(0, 10)}`);
}

main()
  .catch((e) => { console.error("PRECHECK FAILED:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
