/**
 * iMach match-engine test seed — the cake & cookie market cluster.
 *
 * 10 users (password: 123456) across Hamadan and Tabriz:
 *   2 producers (sell cakes + buy raw materials)
 *   2 raw-material suppliers (everything except milk)
 *   2 milk-only suppliers
 *   2 distributors (buy wholesale from producers, sell by carton)
 *   2 supermarkets (buy cakes in small volumes)
 *
 * Idempotent: safe to run repeatedly. Run: npx tsx prisma/seed-market.ts
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { provinceOf } from "../src/common/geo/cities";

const prisma = new PrismaClient();

const PASSWORD = "123456";

// ─── Reference goods — ensured under catalog categories (slug) ───────────────
const GOODS = [
  { name: "کیک یزدی", en: "Yazdi cake", cat: "bakery-snacks", unit: "CARTON" },
  { name: "کیک شطرنجی", en: "Checkerboard cake", cat: "bakery-snacks", unit: "CARTON" },
  { name: "کیک هویج", en: "Carrot cake", cat: "bakery-snacks", unit: "CARTON" },
  { name: "کیک پرتقالی", en: "Orange cake", cat: "bakery-snacks", unit: "CARTON" },
  { name: "کلوچه کشمشی", en: "Raisin cookies", cat: "bakery-snacks", unit: "CARTON" },
  { name: "پودر کاکائو", en: "Cocoa powder", cat: "chemicals", unit: "KILOGRAM" },
  { name: "شیر پاستوریزه", en: "Pasteurized milk", cat: "dairy", unit: "LITER" },
];

const normalize = (s: string): string =>
  s
    .trim()
    .replace(/[\u064A\u0649]/g, "\u06CC")
    .replace(/\u0643/g, "\u06A9")
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/\u200C/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

const CAKES = ["کیک یزدی", "کیک شطرنجی", "کیک هویج", "کیک پرتقالی", "کلوچه کشمشی"];

type SellSpec = { price: number; stock: number; minOrder: number };
type BuySpec = { volume: number; frequency: "WEEKLY" | "MONTHLY" | "OCCASIONAL" };
type Row = { good: string; mode: "SELL" | "BUY" | "BOTH"; sell?: SellSpec; buy?: BuySpec };

interface SeedBusiness {
  slug: string;
  name: string;
  phone: string;
  ownerName: string;
  activityType: string;
  city: string;
  rows: Row[];
}

const B: SeedBusiness[] = [
  {
    slug: "nadari-hamedan",
    name: "نادری",
    phone: "09151010001",
    ownerName: "حاج قربان نادری",
    activityType: "PRODUCER",
    city: "همدان",
    rows: [
      ...CAKES.map((g, i) => ({
        good: g,
        mode: "SELL" as const,
        sell: { price: [720000, 810000, 780000, 750000, 690000][i], stock: 120, minOrder: 1 },
      })),
      { good: "آرد گندم", mode: "BUY", buy: { volume: 200, frequency: "MONTHLY" } },
      { good: "شکر", mode: "BUY", buy: { volume: 120, frequency: "MONTHLY" } },
      { good: "پودر کاکائو", mode: "BUY", buy: { volume: 60, frequency: "MONTHLY" } },
      { good: "شیر پاستوریزه", mode: "BUY", buy: { volume: 400, frequency: "WEEKLY" } },
      { good: "روغن نباتی", mode: "BUY", buy: { volume: 40, frequency: "MONTHLY" } },
    ],
  },
  {
    slug: "shirin-asal-tabriz",
    name: "شیرین عسل",
    phone: "09151010002",
    ownerName: "بابک شیرین‌عسل",
    activityType: "PRODUCER",
    city: "تبریز",
    rows: [
      ...CAKES.map((g, i) => ({
        good: g,
        mode: "SELL" as const,
        sell: { price: [780000, 870000, 840000, 810000, 750000][i], stock: 300, minOrder: 2 },
      })),
      { good: "آرد گندم", mode: "BUY", buy: { volume: 300, frequency: "MONTHLY" } },
      { good: "شکر", mode: "BUY", buy: { volume: 200, frequency: "MONTHLY" } },
      { good: "پودر کاکائو", mode: "BUY", buy: { volume: 90, frequency: "MONTHLY" } },
      { good: "شیر پاستوریزه", mode: "BUY", buy: { volume: 600, frequency: "WEEKLY" } },
      { good: "روغن نباتی", mode: "BUY", buy: { volume: 60, frequency: "MONTHLY" } },
    ],
  },
  {
    slug: "zagros-materials",
    name: "زاگرس مواد اولیه",
    phone: "09151010003",
    ownerName: "کریم زاگرسی",
    activityType: "WHOLESALER",
    city: "همدان",
    rows: [
      { good: "آرد گندم", mode: "SELL", sell: { price: 950000, stock: 800, minOrder: 10 } },
      { good: "شکر", mode: "SELL", sell: { price: 2100000, stock: 500, minOrder: 10 } },
      { good: "پودر کاکائو", mode: "SELL", sell: { price: 850000, stock: 150, minOrder: 5 } },
      { good: "روغن نباتی", mode: "SELL", sell: { price: 1310000, stock: 400, minOrder: 5 } },
    ],
  },
  {
    slug: "azarbad-materials",
    name: "آذرباد مواد اولیه",
    phone: "09151010004",
    ownerName: "صمد آذربادی",
    activityType: "WHOLESALER",
    city: "تبریز",
    rows: [
      { good: "آرد گندم", mode: "SELL", sell: { price: 935000, stock: 1500, minOrder: 20 } },
      { good: "شکر", mode: "SELL", sell: { price: 2080000, stock: 900, minOrder: 20 } },
      { good: "پودر کاکائو", mode: "SELL", sell: { price: 835000, stock: 300, minOrder: 10 } },
      { good: "روغن نباتی", mode: "SELL", sell: { price: 1290000, stock: 700, minOrder: 10 } },
    ],
  },
  {
    slug: "kosar-milk-hamedan",
    name: "کوثر شیر همدان",
    phone: "09151010005",
    ownerName: "مهدی کوثری",
    activityType: "PRODUCER",
    city: "همدان",
    rows: [
      { good: "شیر پاستوریزه", mode: "SELL", sell: { price: 30000, stock: 1000, minOrder: 20 } },
    ],
  },
  {
    slug: "kosar-milk-tabriz",
    name: "کوثر شیر تبریز",
    phone: "09151010006",
    ownerName: "رسول کوثری‌نژاد",
    activityType: "PRODUCER",
    city: "تبریز",
    rows: [
      { good: "شیر پاستوریزه", mode: "SELL", sell: { price: 29000, stock: 1500, minOrder: 20 } },
    ],
  },
  {
    slug: "aria-pakhsh-hamedan",
    name: "پخش آریا",
    phone: "09151010007",
    ownerName: "اکبر آریایی",
    activityType: "DISTRIBUTOR",
    city: "همدان",
    rows: [
      // پخش = BOTH: از تولیدکننده خرید عمده، فروش کارتنی به سوپرمارکت
      ...CAKES.map((g, i) => ({
        good: g,
        mode: "BOTH" as const,
        sell: { price: Math.round([720000, 810000, 780000, 750000, 690000][i] * 1.08), stock: 40, minOrder: 1 },
        buy: { volume: 60, frequency: "MONTHLY" as const },
      })),
    ],
  },
  {
    slug: "azaran-pakhsh-tabriz",
    name: "پخش آذران",
    phone: "09151010008",
    ownerName: "یاشار آذری",
    activityType: "DISTRIBUTOR",
    city: "تبریز",
    rows: [
      ...CAKES.map((g, i) => ({
        good: g,
        mode: "BOTH" as const,
        sell: { price: Math.round([780000, 870000, 840000, 810000, 750000][i] * 1.08), stock: 50, minOrder: 1 },
        buy: { volume: 80, frequency: "MONTHLY" as const },
      })),
    ],
  },
  {
    slug: "super-nikroosh-hamedan",
    name: "سوپرمارکت نیک‌روش",
    phone: "09151010009",
    ownerName: "علی نیک‌روش",
    activityType: "RETAILER",
    city: "همدان",
    rows: CAKES.map((g) => ({ good: g, mode: "BUY" as const, buy: { volume: 3, frequency: "WEEKLY" as const } })),
  },
  {
    slug: "super-arin-tabriz",
    name: "سوپرمارکت آرین",
    phone: "09151010010",
    ownerName: "سامان آرینی",
    activityType: "RETAILER",
    city: "تبریز",
    rows: CAKES.map((g) => ({ good: g, mode: "BUY" as const, buy: { volume: 4, frequency: "WEEKLY" as const } })),
  },
];

async function main() {
  // ── goods (ensured under catalog categories; آرد/شکر/… come from the main seed) ──
  const goodId = new Map<string, string>();
  for (const g of GOODS) {
    const cat = await prisma.category.findUnique({ where: { slug: g.cat }, select: { id: true } });
    if (!cat) throw new Error(`Category «${g.cat}» missing — run the main seed first (npm run seed)`);
    const searchText = normalize([g.name, g.en].filter(Boolean).join(" "));
    const data = {
      categoryId: cat.id,
      nameFa: g.name,
      nameEn: g.en ?? null,
      searchText,
      unit: g.unit,
      source: "SEED",
      status: "ACTIVE",
    };
    const existing = await prisma.good.findFirst({ where: { searchText } });
    const row = existing ? await prisma.good.update({ where: { id: existing.id }, data }) : await prisma.good.create({ data });
    goodId.set(g.name, row.id);
  }
  const existingNames = [...new Set(B.flatMap((b) => b.rows.map((r) => r.good)))].filter((n) => !goodId.has(n));
  for (const name of existingNames) {
    const row = await prisma.good.findFirst({ where: { nameFa: name } });
    if (!row) throw new Error(`Good «${name}» is missing from the catalog — run the main seed first`);
    goodId.set(name, row.id);
  }
  console.log(`goods ready: ${goodId.size} referenced`);

  // ── users + businesses + listings ──
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  for (const b of B) {
    const user = await prisma.user.upsert({
      where: { phone: b.phone },
      create: { phone: b.phone, name: b.ownerName, passwordHash },
      update: { passwordHash },
    });

    const business = await prisma.business.upsert({
      where: { slug: b.slug },
      create: {
        slug: b.slug,
        name: b.name,
        activityType: b.activityType,
        city: b.city,
        province: provinceOf(b.city),
        country: "IR",
        currency: "IRR",
        phone: b.phone,
        ownerId: user.id,
      },
      update: { city: b.city, province: provinceOf(b.city), ownerId: user.id, currency: "IRR" },
    });

    for (const row of b.rows) {
      const gid = goodId.get(row.good) as string;
      // demo numbers were Toman → RIAL = ×10 (smallest unit of IRR)
      const x10 = (v: number) => v * 10;
      const data =
        row.mode === "SELL"
          ? { mode: "SELL", priceMinor: x10(row.sell!.price), currency: "IRR", stock: row.sell!.stock, minOrder: row.sell!.minOrder, volume: null, frequency: null }
          : row.mode === "BUY"
            ? { mode: "BUY", priceMinor: null, currency: null, stock: null, minOrder: null, volume: row.buy!.volume, frequency: row.buy!.frequency }
            : {
                mode: "BOTH",
                priceMinor: x10(row.sell!.price),
                currency: "IRR",
                stock: row.sell!.stock,
                minOrder: row.sell!.minOrder,
                volume: row.buy!.volume,
                frequency: row.buy!.frequency,
              };
      await prisma.listing.upsert({
        where: { businessId_goodId: { businessId: business.id, goodId: gid } },
        create: { businessId: business.id, goodId: gid, ...data },
        update: data,
      });
    }
    console.log(`seeded: ${b.name} (${b.city}) — ${b.rows.length} listings`);
  }

  // ── province/country backfill for every pre-existing business ──
  const all = await prisma.business.findMany({ select: { id: true, city: true, province: true } });
  let fixed = 0;
  for (const biz of all) {
    if (!biz.province) {
      await prisma.business.update({
        where: { id: biz.id },
        data: { province: provinceOf(biz.city), country: "IR" },
      });
      fixed++;
    }
  }
  console.log(`province backfill: ${fixed} business(es) updated`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
