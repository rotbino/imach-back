/*
 * Phase 7 pre-check — وضعیت دیتای دمو برای طرح ۱۰/۱۱ (تأمین‌کنندگان + پیشنهادها)
 * فقط خواندن؛ هیچ تغییری نمی‌دهد.
 * اجرا: node scripts/phase7-precheck.js  (.env با dotenv بارگذاری می‌شود)
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
    select: { id: true, name: true, city: true, province: true, trade: true, activityType: true },
  });
  if (!demo) throw new Error("demo business not found");
  console.log(`DEMO: ${demo.name} · ${demo.city} · ${demo.province} · trade=${demo.trade}`);

  // ۱) کالاهای دنبال‌شده + BUY listingهای دمو
  const [watched, buyListings] = await Promise.all([
    prisma.watchedGood.findMany({
      where: { businessId: demo.id },
      select: { goodId: true, createdAt: true },
    }),
    prisma.listing.findMany({
      where: { businessId: demo.id, mode: { in: ["BUY", "BOTH"] }, isActive: true },
      select: { id: true, goodId: true, volume: true, frequency: true },
    }),
  ]);
  const goodIds = [...new Set([...watched.map((w) => w.goodId), ...buyListings.map((l) => l.goodId)])];
  const goods = await prisma.good.findMany({
    where: { id: { in: goodIds } },
    select: { id: true, nameFa: true, unit: true, categoryId: true, category: { select: { id: true, nameFa: true, parentId: true } } },
  });
  console.log("\nWATCHED/BUY goods:");
  for (const g of goods) {
    const w = watched.find((x) => x.goodId === g.id);
    const b = buyListings.find((x) => x.goodId === g.id);
    console.log(`  ${g.nameFa} (unit=${g.unit}, cat=${g.category?.nameFa}) watch=${!!w} buy=${!!b} vol=${b?.volume ?? "—"} freq=${b?.frequency ?? "—"}`);
  }

  // ۲) فالوهای دمو (میز خرید)
  const follows = await prisma.follow.findMany({
    where: { followerPage: { businessId: demo.id, type: "BUY" } },
    select: { createdAt: true, viaRef: true, supplierPage: { select: { businessId: true, type: true, business: { select: { name: true, city: true, isVerified: true } } } } },
  });
  console.log(`\nFOLLOWS (mine): ${follows.length}`);
  for (const f of follows) console.log(`  ${f.supplierPage.business.name} (${f.supplierPage.business.city}) verified=${f.supplierPage.business.isVerified}`);

  // ۳) فالوهای معکوس (خودش آمد)
  const theirs = await prisma.follow.findMany({
    where: { supplierPage: { businessId: demo.id, type: "BUY" }, followerPage: { type: "SELL" } },
    select: { createdAt: true, followerPage: { select: { business: { select: { name: true, city: true, isVerified: true } } } } },
  });
  console.log(`FOLLOWERS of my BUY page (خودش آمد): ${theirs.length}`);
  for (const t of theirs) console.log(`  ${t.followerPage.business.name} (${t.followerPage.business.city})`);

  // ۴) تابلوهای کالاهای دمو — چه کسی چه قیمتی می‌فروشد
  const supply = await prisma.listing.findMany({
    where: {
      goodId: { in: goodIds },
      isActive: true,
      mode: { in: ["SELL", "BOTH"] },
      priceMinor: { not: null },
      businessId: { not: demo.id },
    },
    select: {
      id: true, goodId: true, priceMinor: true, currency: true, minOrder: true, stock: true,
      variantLabel: true, updatedAt: true,
      business: { select: { id: true, name: true, city: true, isVerified: true } },
    },
    orderBy: { priceMinor: "asc" },
  });
  console.log(`\nSUPPLY per good (sorted by price):`);
  const byGood = new Map();
  for (const s of supply) {
    if (!byGood.has(s.goodId)) byGood.set(s.goodId, []);
    byGood.get(s.goodId).push(s);
  }
  for (const [gid, rows] of byGood) {
    const g = goods.find((x) => x.id === gid);
    const followedIds = new Set(follows.map((f) => f.supplierPage.businessId));
    console.log(`  ${g?.nameFa}:`);
    for (const r of rows.slice(0, 8)) {
      const days = Math.floor((Date.now() - r.updatedAt.getTime()) / 86400000);
      console.log(
        `    ${r.business.name} (${r.business.city}) — ${r.priceMinor} · min=${r.minOrder} · stock=${r.stock} · ${r.variantLabel ?? ""} · ${days}d` +
          (followedIds.has(r.business.id) ? " [FOLLOWED]" : "") +
          (theirs.some((t) => t.followerPage.business.name === r.business.name) ? " [THEIRS]" : "")
      );
    }
  }

  // ۵) سابقه استعلام دمو (خریده‌ام از او)
  const inquiries = await prisma.inquiry.findMany({
    where: { buyerId: demo.id },
    select: { sellerId: true, status: true, createdAt: true, listing: { select: { goodId: true } } },
    take: 30,
  });
  console.log(`\nMY INQUIRIES: ${inquiries.length}`);
  const sellers = await prisma.business.findMany({
    where: { id: { in: [...new Set(inquiries.map((i) => i.sellerId))] } },
    select: { id: true, name: true },
  });
  for (const s of sellers) {
    const n = inquiries.filter((i) => i.sellerId === s.id).length;
    console.log(`  ${s.name}: ${n} inquiries`);
  }

  // ۶) کالاهای هم‌دسته‌ی کالاهای دمو (برای جایگزین‌ها)
  const catIds = [...new Set(goods.map((g) => g.categoryId).filter(Boolean))];
  if (catIds.length > 0) {
    const siblings = await prisma.good.findMany({
      where: { categoryId: { in: catIds } },
      select: { id: true, nameFa: true, categoryId: true },
    });
    console.log(`\nSIBLING goods (same categories):`);
    for (const c of catIds) {
      const cat = goods.find((g) => g.categoryId === c)?.category;
      const sibs = siblings.filter((s) => s.categoryId === c).map((s) => s.nameFa);
      console.log(`  cat=${cat?.nameFa ?? c}: ${sibs.join(" | ")}`);
    }
    // قیمت‌گذاری کالاهای خواهری — چه کسی می‌فروشد
    const sibIds = siblings.map((s) => s.id).filter((id) => !goodIds.includes(id));
    const sibSupply = await prisma.listing.findMany({
      where: { goodId: { in: sibIds }, isActive: true, mode: { in: ["SELL", "BOTH"] }, priceMinor: { not: null }, businessId: { not: demo.id } },
      select: { goodId: true, priceMinor: true, minOrder: true, stock: true, variantLabel: true, business: { select: { name: true, city: true } } },
    });
    const sibByGood = new Map();
    for (const s of sibSupply) {
      if (!sibByGood.has(s.goodId)) sibByGood.set(s.goodId, []);
      sibByGood.get(s.goodId).push(s);
    }
    for (const [gid, rows] of sibByGood) {
      const g = siblings.find((x) => x.id === gid);
      console.log(`  ${g?.nameFa}: ${rows.map((r) => `${r.business.name}@${r.priceMinor}`).join(" · ")}`);
    }
  }
}

main()
  .catch((e) => {
    console.error("PRECHECK FAILED:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
