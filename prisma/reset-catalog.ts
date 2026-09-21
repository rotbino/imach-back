/**
 * One-shot reset of catalog-dependent collections — the catalog shape changed
 * (Good → nameFa/searchText/category tree, Listing → priceMinor/brand/attrs).
 * Users, businesses and follows survive; seeds rebuild the rest.
 * Run: npx tsx prisma/reset-catalog.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // children of listings first, then listings, then the catalog
  const offers = await prisma.offer.deleteMany({});
  const inquiries = await prisma.inquiry.deleteMany({});
  const logs = await prisma.priceLog.deleteMany({});
  const listings = await prisma.listing.deleteMany({});
  const goods = await prisma.good.deleteMany({});
  const brands = await prisma.brand.deleteMany({});
  const cats = await prisma.category.deleteMany({});
  console.log(
    `reset ok — offers:${offers.count} inquiries:${inquiries.count} logs:${logs.count} listings:${listings.count} goods:${goods.count} brands:${brands.count} categories:${cats.count}`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
