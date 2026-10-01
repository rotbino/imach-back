// Phase 4 pre-check: demo user's business, custom categories, listings, inquiries
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findFirst({
    where: { phone: "989196421264" },
    select: { id: true, phone: true, businesses: { select: { id: true, name: true, slug: true, city: true, activityType: true, trade: true, customCategories: true } } },
  });
  console.log("USER:", JSON.stringify(user, null, 2));

  if (user?.businesses?.length) {
    const biz = user.businesses[0];
    const listings = await prisma.listing.findMany({
      where: { businessId: biz.id },
      select: { id: true, mode: true, priceMinor: true, stock: true, isActive: true, variantLabel: true, catalogCategoryId: true, good: { select: { nameFa: true } }, product: { select: { label: true } } },
    });
    console.log(`\nLISTINGS (${listings.length}):`);
    listings.forEach((l) => console.log(` - ${l.good?.nameFa} / ${l.product?.title ?? "فله"} / variant=${l.variantLabel} / cat=${l.catalogCategoryId} / ${l.mode} / price=${l.priceMinor} / active=${l.isActive}`));

    const inq = await prisma.inquiry.findMany({
      where: { sellerId: biz.id },
      select: { id: true, status: true, isRead: true, volume: true, note: true, createdAt: true, buyer: { select: { name: true, city: true } }, listing: { select: { id: true } } },
    });
    console.log(`\nINQUIRIES for seller (${inq.length}):`);
    inq.forEach((i) => console.log(` - ${i.buyer?.name} / vol=${i.volume} / status=${i.status} / read=${i.isRead} / note=${i.note?.slice(0, 40)}`));

    const inqOut = await prisma.inquiry.count({ where: { buyerId: biz.id } });
    console.log(`\nInquiries sent BY this biz (as buyer): ${inqOut}`);
  }

  // what other demo businesses exist (potential buyers for inquiries)?
  const recentBiz = await prisma.business.findMany({
    take: 40,
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, slug: true, city: true, activityType: true, isVerified: true, createdAt: true },
  });
  console.log("\nRECENT BUSINESSES:");
  recentBiz.forEach((b) => console.log(` - ${b.name} / ${b.city} / ${b.activityType} / verified=${b.isVerified} / ${b.createdAt?.toISOString?.().slice(0, 10)}`));

  // Buyer-side BUY listings matching rice (for فرصت‌های بازار opportunities)
  const buyListings = await prisma.listing.findMany({
    where: { mode: { in: ["BUY", "BOTH"] } },
    take: 30,
    select: { id: true, mode: true, volume: true, priceMinor: true, businessId: true, good: { select: { nameFa: true } } },
  });
  console.log(`\nBUY-side listings total sample (${buyListings.length}):`);
  buyListings.forEach((l) => console.log(` - ${l.good?.nameFa} / biz=${l.businessId} / vol=${l.volume} / ${l.mode}`));
}

main().catch(console.error).finally(() => prisma.$disconnect());
