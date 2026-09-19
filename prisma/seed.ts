/**
 * iMach seed — ports the validated prototype demo data into MongoDB.
 * Idempotent: safe to run repeatedly (upserts everywhere).
 *
 * Demo accounts: phone 0912000000N / password "ImachDemo1234" (N = 1..11)
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ─── Reference catalog ───────────────────────────────────────────────────────
const GOODS: { name: string; category: string; unit: string }[] = [
  { name: "برنج هاشمی", category: "حبوبات و غلات", unit: "KILOGRAM" },
  { name: "آرد گندم", category: "حبوبات و غلات", unit: "SACK" },
  { name: "گندم خام", category: "حبوبات و غلات", unit: "TON" },
  { name: "عدس", category: "حبوبات و غلات", unit: "KILOGRAM" },
  { name: "لوبیا قرمز", category: "حبوبات و غلات", unit: "KILOGRAM" },
  { name: "نخود", category: "حبوبات و غلات", unit: "KILOGRAM" },
  { name: "روغن نباتی", category: "روغن و خواربار", unit: "CARTON" },
  { name: "شکر", category: "روغن و خواربار", unit: "SACK" },
  { name: "ماکارونی", category: "روغن و خواربار", unit: "CARTON" },
  { name: "رب گوجه‌فرنگی", category: "روغن و خواربار", unit: "CARTON" },
  { name: "چای سیاه", category: "نوشیدنی", unit: "CARTON" },
  { name: "آب‌میوه", category: "نوشیدنی", unit: "CARTON" },
  { name: "عسل طبیعی", category: "خشکبار و سوغات", unit: "KILOGRAM" },
  { name: "پسته", category: "خشکبار و سوغات", unit: "KILOGRAM" },
  { name: "کشمش", category: "خشکبار و سوغات", unit: "KILOGRAM" },
  { name: "خرما", category: "خشکبار و سوغات", unit: "KILOGRAM" },
  { name: "کارتن بسته‌بندی", category: "مواد تولید و بسته‌بندی", unit: "PIECE" },
  { name: "فیلم سلفون بسته‌بندی", category: "مواد تولید و بسته‌بندی", unit: "BRANCH" },
];

// ─── Demo businesses (suppliers + buyer pool) ────────────────────────────────
type SellSpec = { price: number; stock: number; minOrder: number };
type BuySpec = { volume: number; frequency: "WEEKLY" | "MONTHLY" | "OCCASIONAL" };
type DemoListing = { good: string; mode: "SELL" | "BUY" | "BOTH"; sell?: SellSpec; buy?: BuySpec };

interface DemoBusiness {
  slug: string;
  name: string;
  role: "RETAILER" | "WHOLESALER" | "PRODUCER" | "MARKETER";
  city: string;
  phone: string;
  listings: DemoListing[];
}

const BUSINESSES: DemoBusiness[] = [
  {
    slug: "khorshid-market",
    name: "خورشید مارکت",
    role: "RETAILER",
    city: "تهران",
    phone: "09120000001",
    listings: [
      { good: "برنج هاشمی", mode: "BOTH", sell: { price: 87000, stock: 600, minOrder: 5 }, buy: { volume: 2000, frequency: "MONTHLY" } },
      { good: "روغن نباتی", mode: "BOTH", sell: { price: 1380000, stock: 120, minOrder: 2 }, buy: { volume: 300, frequency: "MONTHLY" } },
      { good: "شکر", mode: "BOTH", sell: { price: 2180000, stock: 130, minOrder: 5 }, buy: { volume: 40, frequency: "MONTHLY" } },
      { good: "چای سیاه", mode: "BOTH", sell: { price: 2980000, stock: 45, minOrder: 1 }, buy: { volume: 25, frequency: "MONTHLY" } },
      { good: "ماکارونی", mode: "SELL", sell: { price: 655000, stock: 80, minOrder: 5 } },
      { good: "عدس", mode: "BUY", buy: { volume: 800, frequency: "MONTHLY" } },
    ],
  },
  {
    slug: "tabiat-daneh",
    name: "طبیعت‌دانه پخش",
    role: "WHOLESALER",
    city: "تهران",
    phone: "09120000002",
    listings: [
      { good: "برنج هاشمی", mode: "SELL", sell: { price: 79500, stock: 18000, minOrder: 500 } },
      { good: "عدس", mode: "SELL", sell: { price: 68500, stock: 9000, minOrder: 300 } },
      { good: "لوبیا قرمز", mode: "SELL", sell: { price: 72800, stock: 7000, minOrder: 300 } },
      { good: "نخود", mode: "SELL", sell: { price: 58400, stock: 5000, minOrder: 300 } },
      { good: "گندم خام", mode: "BUY", buy: { volume: 60, frequency: "MONTHLY" } },
    ],
  },
  {
    slug: "berenj-gilan",
    name: "برنج‌سرای گیلان",
    role: "WHOLESALER",
    city: "رشت",
    phone: "09120000003",
    listings: [
      { good: "برنج هاشمی", mode: "SELL", sell: { price: 80500, stock: 12000, minOrder: 400 } },
      { good: "عدس", mode: "SELL", sell: { price: 67000, stock: 4000, minOrder: 200 } },
    ],
  },
  {
    slug: "pakhsh-gostar",
    name: "پخش گستر البرز",
    role: "WHOLESALER",
    city: "کرج",
    phone: "09120000004",
    listings: [
      { good: "روغن نباتی", mode: "SELL", sell: { price: 1315000, stock: 2400, minOrder: 50 } },
      { good: "شکر", mode: "SELL", sell: { price: 2075000, stock: 1800, minOrder: 50 } },
      { good: "آب‌میوه", mode: "SELL", sell: { price: 478000, stock: 900, minOrder: 30 } },
      { good: "رب گوجه‌فرنگی", mode: "SELL", sell: { price: 1120000, stock: 600, minOrder: 25 } },
    ],
  },
  {
    slug: "shirin-asal",
    name: "شیرین‌عسل اردبیل",
    role: "PRODUCER",
    city: "اردبیل",
    phone: "09120000005",
    listings: [
      { good: "عسل طبیعی", mode: "SELL", sell: { price: 645000, stock: 3200, minOrder: 10 } },
      { good: "کارتن بسته‌بندی", mode: "BUY", buy: { volume: 4000, frequency: "MONTHLY" } },
      { good: "فیلم سلفون بسته‌بندی", mode: "BUY", buy: { volume: 800, frequency: "MONTHLY" } },
    ],
  },
  {
    slug: "asyab-pars",
    name: "آسیاب پارس مشهد",
    role: "PRODUCER",
    city: "مشهد",
    phone: "09120000006",
    listings: [
      { good: "آرد گندم", mode: "SELL", sell: { price: 965000, stock: 8000, minOrder: 100 } },
      { good: "گندم خام", mode: "BUY", buy: { volume: 120, frequency: "WEEKLY" } },
      { good: "کارتن بسته‌بندی", mode: "BUY", buy: { volume: 2500, frequency: "MONTHLY" } },
    ],
  },
  {
    slug: "omid-trading",
    name: "تجارت‌سرای امید",
    role: "MARKETER",
    city: "تهران",
    phone: "09120000007",
    listings: [
      { good: "چای سیاه", mode: "SELL", sell: { price: 2790000, stock: 300, minOrder: 20 } },
      { good: "ماکارونی", mode: "SELL", sell: { price: 618000, stock: 400, minOrder: 30 } },
      { good: "آب‌میوه", mode: "SELL", sell: { price: 452000, stock: 260, minOrder: 30 } },
    ],
  },
  // ── Buyer pool (creates realistic demand) ──
  {
    slug: "hyper-mehrban",
    name: "هایپر مهربان",
    role: "RETAILER",
    city: "تهران",
    phone: "09120000008",
    listings: [
      { good: "روغن نباتی", mode: "BUY", buy: { volume: 40, frequency: "MONTHLY" } },
      { good: "برنج هاشمی", mode: "BUY", buy: { volume: 500, frequency: "MONTHLY" } },
      { good: "ماکارونی", mode: "BUY", buy: { volume: 30, frequency: "WEEKLY" } },
    ],
  },
  {
    slug: "nikavar",
    name: "پخش نیک‌آور",
    role: "WHOLESALER",
    city: "قم",
    phone: "09120000009",
    listings: [
      { good: "چای سیاه", mode: "BUY", buy: { volume: 60, frequency: "MONTHLY" } },
      { good: "شکر", mode: "BUY", buy: { volume: 100, frequency: "MONTHLY" } },
      { good: "برنج هاشمی", mode: "BUY", buy: { volume: 2000, frequency: "MONTHLY" } },
    ],
  },
  {
    slug: "rahat-bakery",
    name: "نان‌وری رحمت",
    role: "PRODUCER",
    city: "کرج",
    phone: "09120000010",
    listings: [
      { good: "آرد گندم", mode: "BUY", buy: { volume: 300, frequency: "WEEKLY" } },
      { good: "شکر", mode: "BUY", buy: { volume: 50, frequency: "WEEKLY" } },
    ],
  },
  {
    slug: "zeytoun",
    name: "فروشگاه زیتون",
    role: "RETAILER",
    city: "شیراز",
    phone: "09120000011",
    listings: [
      { good: "آب‌میوه", mode: "BUY", buy: { volume: 25, frequency: "MONTHLY" } },
      { good: "عسل طبیعی", mode: "BUY", buy: { volume: 20, frequency: "MONTHLY" } },
      { good: "خرما", mode: "BUY", buy: { volume: 150, frequency: "MONTHLY" } },
    ],
  },
];

const DEMO_PASSWORD = "ImachDemo1234";

// Follow graph: khorshid-market (retailer) follows its main suppliers
const FOLLOWS: { buyerSlug: string; supplierSlug: string }[] = [
  { buyerSlug: "khorshid-market", supplierSlug: "tabiat-daneh" },
  { buyerSlug: "khorshid-market", supplierSlug: "pakhsh-gostar" },
  { buyerSlug: "khorshid-market", supplierSlug: "berenj-gilan" },
  { buyerSlug: "nikavar", supplierSlug: "omid-trading" },
  { buyerSlug: "zeytoun", supplierSlug: "shirin-asal" },
  { buyerSlug: "hyper-mehrban", supplierSlug: "omid-trading" },
];

async function main(): Promise<void> {
  console.log("🌱 Seeding iMach …");

  // 1) Goods
  const goodIds = new Map<string, string>();
  for (const g of GOODS) {
    const row = await prisma.good.upsert({
      where: { name: g.name },
      create: { name: g.name, category: g.category, unit: g.unit as never },
      update: { category: g.category, unit: g.unit as never },
    });
    goodIds.set(g.name, row.id);
  }
  console.log(`  ✓ ${GOODS.length} reference goods`);

  // 2) Businesses + owner users + listings
  const bizIds = new Map<string, string>();
  let n = 1;
  for (const b of BUSINESSES) {
    const user = await prisma.user.upsert({
      where: { phone: b.phone },
      create: {
        name: `مدیر ${b.name}`,
        phone: b.phone,
        passwordHash: await (await import("bcryptjs")).hash(DEMO_PASSWORD, 10),
      },
      update: {},
    });

    const biz = await prisma.business.upsert({
      where: { slug: b.slug },
      create: {
        slug: b.slug,
        name: b.name,
        role: b.role as never,
        city: b.city,
        phone: b.phone,
        isDemo: true,
        isVerified: true,
        ownerId: user.id,
      },
      update: { ownerId: user.id, isDemo: true, isVerified: true },
    });
    bizIds.set(b.slug, biz.id);

    for (const l of b.listings) {
      const goodId = goodIds.get(l.good);
      if (!goodId) throw new Error(`Unknown good: ${l.good}`);
      const data = {
        mode: l.mode as never,
        ...(l.mode !== "BUY" && l.sell
          ? { price: l.sell.price, stock: l.sell.stock, minOrder: l.sell.minOrder }
          : { price: null, stock: null, minOrder: null }),
        ...(l.mode !== "SELL" && l.buy
          ? { volume: l.buy.volume, frequency: l.buy.frequency as never }
          : { volume: null, frequency: null }),
      };
      await prisma.listing.upsert({
        where: { businessId_goodId: { businessId: biz.id, goodId } },
        create: { businessId: biz.id, goodId, ...data },
        update: data,
      });
    }
    n++;
  }
  console.log(`  ✓ ${BUSINESSES.length} demo businesses with listings (password: ${DEMO_PASSWORD})`);

  // 3) Follows
  for (const f of FOLLOWS) {
    const buyerId = bizIds.get(f.buyerSlug);
    const supplierId = bizIds.get(f.supplierSlug);
    if (!buyerId || !supplierId) continue;
    await prisma.follow.upsert({
      where: { buyerId_supplierId: { buyerId, supplierId } },
      create: { buyerId, supplierId },
      update: {},
    });
  }
  console.log(`  ✓ ${FOLLOWS.length} follows`);

  // 4) Price history for a few listings (trends on the live board)
  const riceTabiat = await prisma.listing.findFirst({
    where: { business: { slug: "tabiat-daneh" }, good: { name: "برنج هاشمی" } },
  });
  if (riceTabiat && (await prisma.priceLog.count({ where: { listingId: riceTabiat.id } })) === 0) {
    const base = riceTabiat.price ?? 79500;
    await prisma.priceLog.createMany({
      data: [
        { listingId: riceTabiat.id, oldPrice: base + 1500, newPrice: base + 700 },
        { listingId: riceTabiat.id, oldPrice: base + 700, newPrice: base },
      ],
    });
  }
  console.log("  ✓ price history");

  // 5) A few real inquiries (seller-side demo content)
  const inquiryCount = await prisma.inquiry.count();
  if (inquiryCount === 0) {
    const demoInquiries: { buyerSlug: string; sellerSlug: string; good: string; volume: number; note?: string }[] = [
      { buyerSlug: "hyper-mehrban", sellerSlug: "omid-trading", good: "ماکارونی", volume: 30, note: "قیمت عمده برای همکاری مستمر می‌خواهم." },
      { buyerSlug: "nikavar", sellerSlug: "omid-trading", good: "چای سیاه", volume: 60, note: "پرداخت نقدی، ارسال به انبار خودم." },
      { buyerSlug: "zeytoun", sellerSlug: "shirin-asal", good: "عسل طبیعی", volume: 20 },
    ];
    for (const d of demoInquiries) {
      const buyerId = bizIds.get(d.buyerSlug);
      const sellerId = bizIds.get(d.sellerSlug);
      const goodId = goodIds.get(d.good);
      if (!buyerId || !sellerId || !goodId) continue;
      const sellListing = await prisma.listing.findUnique({
        where: { businessId_goodId: { businessId: sellerId, goodId } },
      });
      if (!sellListing) continue;
      await prisma.inquiry.create({
        data: { buyerId, sellerId, listingId: sellListing.id, volume: d.volume, note: d.note ?? null },
      });
    }
    console.log("  ✓ demo inquiries");
  }

  console.log("✅ Seed complete.");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
