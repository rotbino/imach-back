/*
 * Phase 8 pre-check — وضعیت دیتای دمو برای طرح ۰۷/۱۴ (پروفایل دو-بازویی)
 * فقط خواندن؛ هیچ تغییری نمی‌دهد.
 * اجرا: node scripts/phase8-precheck.js  (.env با dotenv بارگذاری می‌شود)
 */
require("dotenv").config();
// DATABASE_URL محیط سندباکس به فایل لوکال اشاره دارد — ریپو از MONGO_URL استفاده می‌کند
if (process.env.MONGO_URL) process.env.DATABASE_URL = process.env.MONGO_URL;
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const DEMO_PHONE = "989196421264";

async function main() {
  const demo = await prisma.business.findFirst({
    where: { owner: { phone: DEMO_PHONE } },
    select: {
      id: true, name: true, slug: true, city: true, trade: true, activityType: true,
      notifPrefs: true, address: true,
      owner: { select: { name: true, firstName: true, lastName: true } },
    },
  });
  if (!demo) throw new Error("demo business not found");
  console.log(`DEMO: ${demo.name} · ${demo.city} · trade=${demo.trade} · activity=${demo.activityType}`);
  console.log(`OWNER: ${demo.owner?.firstName ?? ""} ${demo.owner?.lastName ?? ""} (${demo.owner?.name})`);
  console.log(`notifs: ${JSON.stringify(demo.notifPrefs)}`);

  // ═══ بازوی فروش (طرح ۰۷): کالا / بازدید ماه / مشتری ═══
  const sellListings = await prisma.listing.findMany({
    where: { businessId: demo.id, mode: { in: ["SELL", "BOTH"] }, isActive: true },
    select: { id: true, viewCount30: true, viewCountTotal: true, good: { select: { nameFa: true } } },
  });
  const viewsMonth = sellListings.reduce((s, l) => s + (l.viewCount30 ?? 0), 0);
  console.log(`\nSELL: ${sellListings.length} active listings · viewsMonth=${viewsMonth}`);
  for (const l of sellListings.slice(0, 8))
    console.log(`  ${l.good.nameFa}: v30=${l.viewCount30 ?? 0} vTotal=${l.viewCountTotal ?? 0}`);

  // مشتریان من = فالوهای صفحه‌ی SELL من
  const customers = await prisma.follow.findMany({
    where: { supplierPage: { businessId: demo.id, type: "SELL" } },
    select: {
      createdAt: true, viaRef: true,
      followerPage: { select: { businessId: true, business: { select: { id: true, name: true, city: true, isVerified: true, slug: true } } } },
    },
  });
  console.log(`\nCUSTOMERS (followers of my SELL page): ${customers.length}`);
  for (const c of customers)
    console.log(`  ${c.followerPage.business.name} (${c.followerPage.business.city}) viaRef=${!!c.viaRef} verified=${c.followerPage.business.isVerified}`);

  // درخواست فعالِ مشتری‌ها = BUY listing آن‌ها روی کالاهایی که من هم می‌فروشم
  if (customers.length > 0) {
    const myGoodIds = await prisma.listing.findMany({
      where: { businessId: demo.id, mode: { in: ["SELL", "BOTH"] } },
      select: { goodId: true },
      distinct: ["goodId"],
    });
    const custBuy = await prisma.listing.findMany({
      where: {
        businessId: { in: customers.map((c) => c.followerPage.businessId) },
        mode: { in: ["BUY", "BOTH"] },
        isActive: true,
        goodId: { in: myGoodIds.map((g) => g.goodId) },
      },
      select: { businessId: true, good: { select: { nameFa: true } }, volume: true, frequency: true, updatedAt: true },
    });
    console.log(`CUSTOMER active buy-requests on my goods: ${custBuy.length}`);
    for (const b of custBuy) {
      const cust = customers.find((c) => c.followerPage.businessId === b.businessId);
      console.log(`  ${cust?.followerPage.business.name}: ${b.good.nameFa} ×${b.volume} ${b.frequency ?? ""}`);
    }
  }

  // ═══ بازوی خرید (طرح ۱۴): لیست / تأمین‌کننده / درخواست باز ═══
  const watched = await prisma.watchedGood.findMany({
    where: { businessId: demo.id },
    select: { good: { select: { nameFa: true } } },
  });
  const follows = await prisma.follow.findMany({
    where: { followerPage: { businessId: demo.id, type: "BUY" } },
    select: { supplierPage: { select: { business: { select: { name: true } } } } },
  });
  const [inquiries, myOffers] = await Promise.all([
    prisma.inquiry.findMany({
      where: { buyerId: demo.id },
      select: { status: true, listingId: true, sellerId: true, listing: { select: { good: { select: { nameFa: true } } } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.offer.findMany({
      where: { buyerId: demo.id },
      select: { listingId: true, sellerId: true },
    }),
  ]);
  const offerKey = new Set(myOffers.map((o) => `${o.listingId}:${o.sellerId}`));
  const open = inquiries.filter((i) => !offerKey.has(`${i.listingId}:${i.sellerId}`));
  console.log(`\nBUY: watched=${watched.length} · follows=${follows.length} · inquiries=${inquiries.length} (open=${open.length})`);
  for (const i of inquiries.slice(0, 8))
    console.log(`  ${i.listing?.good?.nameFa}: status=${i.status} offer=${offerKey.has(`${i.listingId}:${i.sellerId}`)}`);
}

main()
  .catch((e) => {
    console.error("PRECHECK FAILED:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
