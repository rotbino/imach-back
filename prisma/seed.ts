/**
 * iMach seed — reference catalog + demo dataset (idempotent, safe to re-run).
 *
 * 1) Category tree (fa/en) — 8 roots covering agriculture, supermarket,
 *    industry, metals, scrap, apparel, gold and services
 * 2) Reference goods — tradeable CLASSES with Persian/English names + aliases
 * 3) Brands — demo set; user-typed brands are created on the fly by the API
 * 4) Demo businesses + listings — price in priceMinor (RIAL = smallest unit
 *    of IRR), currency inherited per business, brand/attrs on some rows
 *
 * Demo accounts: phone 0912000000N / password "ImachDemo1234" (N = 1..11)
 * Run: npm run seed
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// ─── 1) Category tree ────────────────────────────────────────────────────────

type AttrDef = {
  key: string;
  fa: string;
  en: string;
  type: "enum" | "text";
  options?: { v: string; fa: string; en: string }[];
};

type CatDef = { slug: string; nameFa: string; nameEn: string; attrs?: AttrDef[]; children?: CatDef[] };

const WEIGHT_ATTR: AttrDef = {
  key: "weight",
  fa: "وزن بسته",
  en: "Pack weight",
  type: "enum",
  options: [
    { v: "250g", fa: "۲۵۰ گرمی", en: "250 g" },
    { v: "500g", fa: "۵۰۰ گرمی", en: "500 g" },
    { v: "1kg", fa: "۱ کیلوگرمی", en: "1 kg" },
    { v: "5kg", fa: "۵ کیلوگرمی", en: "5 kg" },
    { v: "10kg", fa: "۱۰ کیلوگرمی", en: "10 kg" },
    { v: "bulk", fa: "فله", en: "Bulk" },
  ],
};

const PACKAGING_ATTR: AttrDef = {
  key: "packaging",
  fa: "نوع بسته‌بندی",
  en: "Packaging",
  type: "enum",
  options: [
    { v: "carton", fa: "کارتن", en: "Carton" },
    { v: "jumbo", fa: "جامبو بگ", en: "Jumbo bag" },
    { v: "retail", fa: "بسته خرده", en: "Retail pack" },
  ],
};

const DIAMETER_ATTR: AttrDef = {
  key: "diameter",
  fa: "قطر",
  en: "Diameter",
  type: "enum",
  options: [8, 10, 12, 14, 16, 18, 20, 22, 25].map((d) => ({
    v: String(d),
    fa: `${d} میل`,
    en: `${d} mm`,
  })),
};

const SIZE_ATTR: AttrDef = {
  key: "size",
  fa: "سایز",
  en: "Size",
  type: "enum",
  options: [
    { v: "S", fa: "S", en: "S" },
    { v: "M", fa: "M", en: "M" },
    { v: "L", fa: "L", en: "L" },
    { v: "XL", fa: "XL", en: "XL" },
  ],
};

export const TREE: CatDef[] = [
  {
    slug: "agri-food",
    nameFa: "کشاورزی و مواد غذایی",
    nameEn: "Agriculture & Food",
    children: [
      {
        slug: "dried-fruit",
        nameFa: "خشکبار",
        nameEn: "Dried Fruit & Nuts",
        attrs: [WEIGHT_ATTR, PACKAGING_ATTR],
      },
      { slug: "grains-legumes", nameFa: "حبوبات و غلات", nameEn: "Grains & Legumes" },
      { slug: "fruits-veg", nameFa: "میوه و سبزیجات", nameEn: "Fruits & Vegetables" },
      { slug: "livestock", nameFa: "دام و طیور", nameEn: "Livestock & Poultry" },
    ],
  },
  {
    slug: "supermarket",
    nameFa: "سوپرمارکت و خواربار",
    nameEn: "Supermarket & Groceries",
    children: [
      { slug: "pantry", nameFa: "روغن و خواربار", nameEn: "Oil & Pantry" },
      { slug: "drinks", nameFa: "نوشیدنی", nameEn: "Beverages" },
      { slug: "dairy", nameFa: "لبنیات", nameEn: "Dairy" },
      { slug: "bakery-snacks", nameFa: "کیک، شیرینی و تنقلات", nameEn: "Bakery & Snacks" },
    ],
  },
  {
    slug: "industry",
    nameFa: "صنعت و مواد اولیه",
    nameEn: "Industry & Raw Materials",
    children: [
      { slug: "polymers", nameFa: "پلیمر و پلاستیک", nameEn: "Polymers & Plastics" },
      { slug: "packaging", nameFa: "بسته‌بندی", nameEn: "Packaging" },
      { slug: "chemicals", nameFa: "مواد شیمیایی", nameEn: "Chemicals" },
    ],
  },
  {
    slug: "metals",
    nameFa: "فلزات",
    nameEn: "Metals",
    children: [
      { slug: "steel", nameFa: "فولاد و آهن", nameEn: "Steel & Iron", attrs: [DIAMETER_ATTR] },
      { slug: "copper", nameFa: "مس و آلیاژ", nameEn: "Copper & Alloys" },
    ],
  },
  {
    slug: "scrap",
    nameFa: "ضایعات و بازیافت",
    nameEn: "Scrap & Recycling",
    children: [
      { slug: "metal-scrap", nameFa: "ضایعات فلزی", nameEn: "Metal Scrap" },
      { slug: "plastic-scrap", nameFa: "ضایعات پلاستیک", nameEn: "Plastic Scrap" },
    ],
  },
  {
    slug: "apparel",
    nameFa: "پوشاک و منسوجات",
    nameEn: "Apparel & Textiles",
    children: [
      { slug: "clothing", nameFa: "پوشاک", nameEn: "Clothing", attrs: [SIZE_ATTR] },
      { slug: "fabric", nameFa: "پارچه", nameEn: "Fabric" },
    ],
  },
  {
    slug: "gold",
    nameFa: "طلا و جواهر",
    nameEn: "Gold & Jewelry",
    children: [{ slug: "gold-items", nameFa: "طلای مصنوع و شمش", nameEn: "Gold & Bullion" }],
  },
  {
    slug: "services",
    nameFa: "خدمات",
    nameEn: "Services",
    children: [
      { slug: "logistics", nameFa: "حمل و نقل", nameEn: "Logistics" },
      { slug: "contract-production", nameFa: "خدمات تولیدی", nameEn: "Contract Manufacturing" },
    ],
  },
];

// ─── 2) Reference goods (tradeable classes — NOT brand SKUs) ─────────────────

type GoodDef = {
  name: string; // Persian canonical
  en?: string;
  alias?: string[];
  unit: string;
  cat: string; // category slug
};

export const GOODS: GoodDef[] = [
  // خشکبار
  { name: "خرمای خازویی", en: "Khasoei dates", alias: ["خازویی", "khasoei"], unit: "CARTON", cat: "dried-fruit" },
  { name: "خرمای پیارم", en: "Piarom dates", alias: ["پیارم", "piarom"], unit: "CARTON", cat: "dried-fruit" },
  { name: "خرمای مضافتی", en: "Mazafati dates", alias: ["مضافتی", "mazafati"], unit: "CARTON", cat: "dried-fruit" },
  { name: "پسته", en: "Pistachio", unit: "KILOGRAM", cat: "dried-fruit" },
  { name: "کشمش", en: "Raisins", unit: "KILOGRAM", cat: "dried-fruit" },
  { name: "عسل طبیعی", en: "Natural honey", alias: ["عسل", "honey"], unit: "KILOGRAM", cat: "dried-fruit" },
  // حبوبات و غلات
  { name: "برنج هاشمی", en: "Hashemi rice", alias: ["هاشمی", "برنج", "rice"], unit: "SACK", cat: "grains-legumes" },
  { name: "آرد گندم", en: "Wheat flour", alias: ["آرد", "flour"], unit: "SACK", cat: "grains-legumes" },
  { name: "گندم خام", en: "Raw wheat", alias: ["گندم", "wheat"], unit: "TON", cat: "grains-legumes" },
  { name: "عدس", en: "Lentils", alias: ["lentils"], unit: "SACK", cat: "grains-legumes" },
  { name: "لوبیا قرمز", en: "Red beans", alias: ["لوبیا", "beans"], unit: "SACK", cat: "grains-legumes" },
  { name: "نخود", en: "Chickpeas", alias: ["chickpeas"], unit: "SACK", cat: "grains-legumes" },
  // میوه و سبزیجات
  { name: "سیب", en: "Apple", unit: "KILOGRAM", cat: "fruits-veg" },
  { name: "پرتقال", en: "Orange", unit: "KILOGRAM", cat: "fruits-veg" },
  { name: "پیاز", en: "Onion", unit: "KILOGRAM", cat: "fruits-veg" },
  // دام و طیور
  { name: "تخم‌مرغ", en: "Eggs", alias: ["مرغ", "egg"], unit: "CARTON", cat: "livestock" },
  { name: "مرغ گرم", en: "Broiler chicken", alias: ["مرغ"], unit: "KILOGRAM", cat: "livestock" },
  // روغن و خواربار
  { name: "روغن نباتی", en: "Vegetable oil", alias: ["روغن", "oil"], unit: "CARTON", cat: "pantry" },
  { name: "شکر", en: "Sugar", alias: ["sugar"], unit: "SACK", cat: "pantry" },
  { name: "ماکارونی", en: "Macaroni", alias: ["پاستا", "pasta"], unit: "CARTON", cat: "pantry" },
  { name: "رب گوجه‌فرنگی", en: "Tomato paste", alias: ["رب", "paste"], unit: "CARTON", cat: "pantry" },
  // نوشیدنی
  { name: "چای سیاه", en: "Black tea", alias: ["چای", "tea"], unit: "CARTON", cat: "drinks" },
  { name: "آب‌میوه", en: "Fruit juice", alias: ["juice"], unit: "CARTON", cat: "drinks" },
  { name: "نوشابه", en: "Soft drink", unit: "CARTON", cat: "drinks" },
  // لبنیات
  { name: "پنیر", en: "Cheese", unit: "KILOGRAM", cat: "dairy" },
  { name: "کره حیوانی", en: "Butter", alias: ["کره"], unit: "KILOGRAM", cat: "dairy" },
  { name: "شیر پاستوریزه", en: "Pasteurized milk", alias: ["شیر", "milk"], unit: "LITER", cat: "dairy" },
  // کیک، شیرینی و تنقلات
  { name: "کیک یزدی", en: "Yazdi cake", unit: "CARTON", cat: "bakery-snacks" },
  { name: "کیک شطرنجی", en: "Checkerboard cake", unit: "CARTON", cat: "bakery-snacks" },
  { name: "کیک هویج", en: "Carrot cake", unit: "CARTON", cat: "bakery-snacks" },
  { name: "کیک پرتقالی", en: "Orange cake", unit: "CARTON", cat: "bakery-snacks" },
  { name: "کلوچه کشمشی", en: "Raisin cookies", unit: "CARTON", cat: "bakery-snacks" },
  { name: "شکلات", en: "Chocolate", unit: "KILOGRAM", cat: "bakery-snacks" },
  { name: "بیسکویت", en: "Biscuits", unit: "CARTON", cat: "bakery-snacks" },
  // پلیمر و پلاستیک
  { name: "گرانول پلی‌اتیلن", en: "Polyethylene granules", alias: ["گرانول"], unit: "KILOGRAM", cat: "polymers" },
  { name: "مستربچ", en: "Masterbatch", unit: "KILOGRAM", cat: "polymers" },
  // بسته‌بندی
  { name: "کارتن بسته‌بندی", en: "Carton boxes", alias: ["کارتن", "carton"], unit: "PIECE", cat: "packaging" },
  { name: "فیلم سلفون بسته‌بندی", en: "Cellophane film", alias: ["سلفون", "فیلم"], unit: "PIECE", cat: "packaging" },
  // مواد شیمیایی
  { name: "پودر کاکائو", en: "Cocoa powder", alias: ["کاکائو", "cocoa"], unit: "KILOGRAM", cat: "chemicals" },
  { name: "اسید سیتریک", en: "Citric acid", unit: "KILOGRAM", cat: "chemicals" },
  // فولاد و آهن
  { name: "میلگرد", en: "Rebar", alias: ["rebar"], unit: "TON", cat: "steel" },
  { name: "ورق گالوانیزه", en: "Galvanized sheet", alias: ["ورق"], unit: "TON", cat: "steel" },
  { name: "تیرآهن", en: "I-beam", unit: "TON", cat: "steel" },
  // مس و آلیاژ
  { name: "شمش مس", en: "Copper ingot", alias: ["مس", "copper"], unit: "KILOGRAM", cat: "copper" },
  { name: "کابل مسی", en: "Copper cable", alias: ["کابل"], unit: "KILOGRAM", cat: "copper" },
  // ضایعات فلزی
  { name: "ضایعات آهن", en: "Iron scrap", alias: ["آهن"], unit: "TON", cat: "metal-scrap" },
  { name: "ضایعات مس", en: "Copper scrap", unit: "KILOGRAM", cat: "metal-scrap" },
  { name: "ضایعات آلومینیوم", en: "Aluminum scrap", alias: ["آلومینیوم"], unit: "KILOGRAM", cat: "metal-scrap" },
  // ضایعات پلاستیک
  { name: "ضایعات پلی‌اتیلن", en: "PE scrap", alias: ["پلی‌اتیلن"], unit: "KILOGRAM", cat: "plastic-scrap" },
  { name: "جام بوتل", en: "PET bales", alias: ["پت"], unit: "KILOGRAM", cat: "plastic-scrap" },
  // پوشاک
  { name: "شلوار جین", en: "Jeans", alias: ["جین", "jeans"], unit: "PIECE", cat: "clothing" },
  { name: "تیشرت", en: "T-shirt", unit: "PIECE", cat: "clothing" },
  // پارچه
  { name: "پارچه نخی", en: "Cotton fabric", alias: ["نخی"], unit: "METER", cat: "fabric" },
  { name: "پارچه پلی‌استر", en: "Polyester fabric", alias: ["پلی‌استر"], unit: "METER", cat: "fabric" },
  // طلا
  { name: "شمش طلا", en: "Gold bullion", alias: ["شمش"], unit: "GRAM", cat: "gold-items" },
  { name: "طلای ۱۸ عیار", en: "18k gold jewelry", alias: ["طلا", "gold"], unit: "GRAM", cat: "gold-items" },
  // خدمات
  { name: "حمل بار جاده‌ای", en: "Road freight", unit: "SERVICE", cat: "logistics" },
  { name: "حمل کانتینری", en: "Container freight", unit: "SERVICE", cat: "logistics" },
  { name: "خدمات بسته‌بندی", en: "Packaging service", unit: "SERVICE", cat: "contract-production" },
  { name: "تولید قراردادی", en: "Contract manufacturing", unit: "SERVICE", cat: "contract-production" },
];

// ─── 3) Brands (user-typed brands are resolved/created by the API) ──────────

const BRANDS = ["امید", "گلستان", "زر", "شکوفه", "طبیعت", "مهرام"];

// ─── 4) Demo businesses ──────────────────────────────────────────────────────
// Prices are in RIALS (IRR smallest unit). Old demo numbers were Toman — ×10.

type SellSpec = { price: number; stock: number; minOrder: number; brand?: string; attrs?: Record<string, string> };
type BuySpec = { volume: number; frequency: "WEEKLY" | "MONTHLY" | "OCCASIONAL" };
type DemoListing = { good: string; mode: "SELL" | "BUY" | "BOTH"; sell?: SellSpec; buy?: BuySpec };

interface DemoBusiness {
  slug: string;
  name: string;
  activityType: string;
  city: string;
  phone: string;
  listings: DemoListing[];
}

const BUSINESSES: DemoBusiness[] = [
  {
    slug: "khorshid-market",
    name: "خورشید مارکت",
    activityType: "RETAILER",
    city: "تهران",
    phone: "09120000001",
    listings: [
      { good: "برنج هاشمی", mode: "BOTH", sell: { price: 870000, stock: 600, minOrder: 5 }, buy: { volume: 2000, frequency: "MONTHLY" } },
      { good: "روغن نباتی", mode: "BOTH", sell: { price: 13800000, stock: 120, minOrder: 2, brand: "مهرام" }, buy: { volume: 300, frequency: "MONTHLY" } },
      { good: "شکر", mode: "BOTH", sell: { price: 21800000, stock: 130, minOrder: 5 }, buy: { volume: 40, frequency: "MONTHLY" } },
      { good: "چای سیاه", mode: "BOTH", sell: { price: 29800000, stock: 45, minOrder: 1, brand: "گلستان" }, buy: { volume: 25, frequency: "MONTHLY" } },
      { good: "ماکارونی", mode: "SELL", sell: { price: 6550000, stock: 80, minOrder: 5, brand: "زر" } },
      { good: "عدس", mode: "BUY", buy: { volume: 800, frequency: "MONTHLY" } },
    ],
  },
  {
    slug: "tabiat-daneh",
    name: "طبیعت‌دانه پخش",
    activityType: "DISTRIBUTOR",
    city: "تهران",
    phone: "09120000002",
    listings: [
      { good: "برنج هاشمی", mode: "SELL", sell: { price: 795000, stock: 18000, minOrder: 500 } },
      { good: "عدس", mode: "SELL", sell: { price: 685000, stock: 9000, minOrder: 300 } },
      { good: "لوبیا قرمز", mode: "SELL", sell: { price: 728000, stock: 7000, minOrder: 300 } },
      { good: "نخود", mode: "SELL", sell: { price: 584000, stock: 5000, minOrder: 300 } },
      { good: "گندم خام", mode: "BUY", buy: { volume: 60, frequency: "MONTHLY" } },
    ],
  },
  {
    slug: "berenj-gilan",
    name: "برنج‌سرای گیلان",
    activityType: "WHOLESALER",
    city: "رشت",
    phone: "09120000003",
    listings: [
      { good: "برنج هاشمی", mode: "SELL", sell: { price: 805000, stock: 12000, minOrder: 400 } },
      { good: "عدس", mode: "SELL", sell: { price: 670000, stock: 4000, minOrder: 200 } },
    ],
  },
  {
    slug: "pakhsh-gostar",
    name: "پخش گستر البرز",
    activityType: "DISTRIBUTOR",
    city: "کرج",
    phone: "09120000004",
    listings: [
      { good: "روغن نباتی", mode: "SELL", sell: { price: 13150000, stock: 2400, minOrder: 50 } },
      { good: "شکر", mode: "SELL", sell: { price: 20750000, stock: 1800, minOrder: 50 } },
      { good: "آب‌میوه", mode: "SELL", sell: { price: 4780000, stock: 900, minOrder: 30 } },
      { good: "رب گوجه‌فرنگی", mode: "SELL", sell: { price: 11200000, stock: 600, minOrder: 25 } },
    ],
  },
  {
    slug: "shirin-asal",
    name: "شیرین‌عسل اردبیل",
    activityType: "PRODUCER",
    city: "اردبیل",
    phone: "09120000005",
    listings: [
      { good: "عسل طبیعی", mode: "SELL", sell: { price: 6450000, stock: 3200, minOrder: 10, brand: "طبیعت" } },
      { good: "کارتن بسته‌بندی", mode: "BUY", buy: { volume: 4000, frequency: "MONTHLY" } },
      { good: "فیلم سلفون بسته‌بندی", mode: "BUY", buy: { volume: 800, frequency: "MONTHLY" } },
    ],
  },
  {
    slug: "asyab-pars",
    name: "آسیاب پارس مشهد",
    activityType: "PRODUCER",
    city: "مشهد",
    phone: "09120000006",
    listings: [
      { good: "آرد گندم", mode: "SELL", sell: { price: 9650000, stock: 8000, minOrder: 100, brand: "شکوفه" } },
      { good: "گندم خام", mode: "BUY", buy: { volume: 120, frequency: "WEEKLY" } },
      { good: "کارتن بسته‌بندی", mode: "BUY", buy: { volume: 2500, frequency: "MONTHLY" } },
    ],
  },
  {
    slug: "omid-trading",
    name: "تجارت‌سرای امید",
    activityType: "MERCHANT",
    city: "تهران",
    phone: "09120000007",
    listings: [
      { good: "خرمای خازویی", mode: "SELL", sell: { price: 6800000, stock: 900, minOrder: 5, brand: "امید", attrs: { weight: "500g", packaging: "carton" } } },
      { good: "خرمای پیارم", mode: "SELL", sell: { price: 15500000, stock: 300, minOrder: 3, brand: "امید", attrs: { weight: "500g", packaging: "carton" } } },
      { good: "چای سیاه", mode: "SELL", sell: { price: 27900000, stock: 300, minOrder: 20, brand: "گلستان" } },
      { good: "ماکارونی", mode: "SELL", sell: { price: 6180000, stock: 400, minOrder: 30, brand: "زر" } },
      { good: "آب‌میوه", mode: "SELL", sell: { price: 4520000, stock: 260, minOrder: 30 } },
    ],
  },
  // ── Buyer pool (creates realistic demand) ──
  {
    slug: "hyper-mehrban",
    name: "هایپر مهربان",
    activityType: "RETAILER",
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
    activityType: "DISTRIBUTOR",
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
    activityType: "BUSINESS_CONSUMER",
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
    activityType: "RETAILER",
    city: "شیراز",
    phone: "09120000011",
    listings: [
      { good: "آب‌میوه", mode: "BUY", buy: { volume: 25, frequency: "MONTHLY" } },
      { good: "عسل طبیعی", mode: "BUY", buy: { volume: 20, frequency: "MONTHLY" } },
      { good: "خرمای مضافتی", mode: "BUY", buy: { volume: 150, frequency: "MONTHLY" } },
    ],
  },
];

const DEMO_PASSWORD = "ImachDemo1234";

const FOLLOWS: { buyerSlug: string; supplierSlug: string }[] = [
  { buyerSlug: "khorshid-market", supplierSlug: "tabiat-daneh" },
  { buyerSlug: "khorshid-market", supplierSlug: "pakhsh-gostar" },
  { buyerSlug: "khorshid-market", supplierSlug: "berenj-gilan" },
  { buyerSlug: "nikavar", supplierSlug: "omid-trading" },
  { buyerSlug: "zeytoun", supplierSlug: "shirin-asal" },
  { buyerSlug: "hyper-mehrban", supplierSlug: "omid-trading" },
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .trim()
    .replace(/[\u064A\u0649]/g, "\u06CC")
    .replace(/\u0643/g, "\u06A9")
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/\u200C/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

async function main(): Promise<void> {
  console.log("Seeding iMach catalog + demo market …");

  // 1) Category tree
  const catIds = new Map<string, string>(); // slug → id
  for (const root of TREE) {
    const parent = await prisma.category.upsert({
      where: { slug: root.slug },
      create: { slug: root.slug, nameFa: root.nameFa, nameEn: root.nameEn, attrs: root.attrs ?? undefined },
      update: { nameFa: root.nameFa, nameEn: root.nameEn, attrs: root.attrs ?? undefined, parentId: null },
    });
    catIds.set(root.slug, parent.id);
    for (const child of root.children ?? []) {
      const row = await prisma.category.upsert({
        where: { slug: child.slug },
        create: { slug: child.slug, nameFa: child.nameFa, nameEn: child.nameEn, attrs: child.attrs ?? undefined, parentId: parent.id },
        update: { nameFa: child.nameFa, nameEn: child.nameEn, attrs: child.attrs ?? undefined, parentId: parent.id },
      });
      catIds.set(child.slug, row.id);
    }
  }
  console.log(`  ok ${catIds.size} categories`);

  // 2) Reference goods
  const goodIds = new Map<string, string>(); // Persian name → id
  for (const g of GOODS) {
    const searchText = normalize([g.name, g.en ?? "", ...(g.alias ?? [])].filter(Boolean).join(" "));
    const existing = await prisma.good.findFirst({ where: { searchText } });
    const data = {
      categoryId: catIds.get(g.cat) as string,
      nameFa: g.name,
      nameEn: g.en ?? null,
      aliases: g.alias ?? [],
      searchText,
      unit: g.unit,
      source: "SEED",
      status: "ACTIVE",
    };
    const row = existing
      ? await prisma.good.update({ where: { id: existing.id }, data })
      : await prisma.good.create({ data });
    goodIds.set(g.name, row.id);
  }
  console.log(`  ok ${GOODS.length} reference goods`);

  // 3) Brands
  const brandIds = new Map<string, string>();
  for (const b of BRANDS) {
    const st = normalize(b);
    const row = await prisma.brand.upsert({
      where: { searchText: st },
      create: { name: b, searchText: st, source: "SEED" },
      update: { name: b },
    });
    brandIds.set(b, row.id);
  }
  console.log(`  ok ${BRANDS.length} brands`);

  // 4) Businesses + owner users + listings
  const bizIds = new Map<string, string>();
  for (const b of BUSINESSES) {
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
    const user = await prisma.user.upsert({
      where: { phone: b.phone },
      create: { name: `مدیر ${b.name}`, phone: b.phone, passwordHash, country: "IR" },
      update: { country: "IR" },
    });

    const biz = await prisma.business.upsert({
      where: { slug: b.slug },
      create: {
        slug: b.slug,
        name: b.name,
        activityType: b.activityType,
        city: b.city,
        phone: b.phone,
        isDemo: true,
        isVerified: true,
        country: "IR",
        currency: "IRR",
        ownerId: user.id,
      },
      update: { ownerId: user.id, isDemo: true, isVerified: true, activityType: b.activityType, currency: "IRR" },
    });
    bizIds.set(b.slug, biz.id);

    for (const l of b.listings) {
      const goodId = goodIds.get(l.good);
      if (!goodId) throw new Error(`Unknown good: ${l.good}`);
      const data = {
        mode: l.mode,
        brandId: l.sell?.brand ? (brandIds.get(l.sell.brand) ?? null) : null,
        ...(l.mode !== "BUY" && l.sell
          ? {
              priceMinor: l.sell.price,
              currency: "IRR",
              stock: l.sell.stock,
              minOrder: l.sell.minOrder,
              attrs: l.sell.attrs ?? undefined,
            }
          : { priceMinor: null, currency: null, stock: null, minOrder: null, attrs: undefined }),
        ...(l.mode !== "SELL" && l.buy
          ? { volume: l.buy.volume, frequency: l.buy.frequency }
          : { volume: null, frequency: null }),
      };
      await prisma.listing.upsert({
        where: { businessId_goodId: { businessId: biz.id, goodId } },
        create: { businessId: biz.id, goodId, ...data },
        update: data,
      });
    }
  }
  console.log(`  ok ${BUSINESSES.length} demo businesses with listings (password: ${DEMO_PASSWORD})`);

  // 5) Follows
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
  console.log(`  ok ${FOLLOWS.length} follows`);

  // 6) Price history for a few listings (trends on the live board)
  const riceTabiat = await prisma.listing.findFirst({
    where: { business: { slug: "tabiat-daneh" }, good: { nameFa: "برنج هاشمی" } },
  });
  if (riceTabiat && (await prisma.priceLog.count({ where: { listingId: riceTabiat.id } })) === 0) {
    const base = riceTabiat.priceMinor ?? 795000;
    await prisma.priceLog.createMany({
      data: [
        { listingId: riceTabiat.id, oldMinor: base + 15000, newMinor: base + 7000 },
        { listingId: riceTabiat.id, oldMinor: base + 7000, newMinor: base },
      ],
    });
  }
  console.log("  ok price history");

  // 7) A few real inquiries (seller-side demo content)
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
    console.log("  ok demo inquiries");
  }

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
