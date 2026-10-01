/*
 * Phase 7 demo seed — دایرکتوری تأمین‌کنندگان + پیشنهادها (design-reference/screens/10 + 11)
 *
 * نوشتن داده‌ی «واقعی» برای کاربر دمو 989196421264 (پخش برنج پارس، رشت):
 *   • تجارت گیل‌رنج (رشت، تازه) — هاشمی ۲۷٬۸۰۰٬۰۰۰ ر با PriceLog ▼ از ۲۸٬۰۰۰٬۰۰۰
 *     → کارت «قیمت بهتر»: ▼ از بهترینِ شبکه‌ی من (انزلی ۲۸٬۵۰۰٬۰۰۰) — عددِ طرح ۱۱
 *   • کیان غلات (قزوین) — هاشمی ۲۹٬۶۰۰٬۰۰۰ + طارم «درجه یک» ۲۶٬۵۰۰٬۰۰۰
 *     → کارت «جایگزین: مشابه برنج هاشمی» (عددِ طرح ۱۱) + چیپ هاشمی در دایرکتوری
 *   • فالوی سعید + سپید از میز خرید دمو → «دنبال‌شده (۳ mine)» مثل طرح ۱۰
 *   • فالوی کیان SELL → میز BUY دمو → برچسب «خودش آمد» در دایرکتوری (طرح ۱۰)
 * ماهان (روغن، بدون استعلام) → کارت «تأمین‌کننده جدید» با MatchRing — از دیتای موجود.
 * Ensure/Repair: هر اجرا وضعیت دمو را «درست» می‌کند؛ اجرای دوباره بی‌ضرر است.
 *
 * اجرا: node scripts/phase7-seed-demo.js  (.env با dotenv بارگذاری می‌شود)
 */
require("dotenv").config();
// DATABASE_URL محیط سندباکس به فایل لوکال اشاره دارد — ریپو از MONGO_URL استفاده می‌کند
if (process.env.MONGO_URL) process.env.DATABASE_URL = process.env.MONGO_URL;
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const DEMO_PHONE = "989196421264";
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo);

async function main() {
  // ── ۱) خریدارِ دمو ──
  const demo = await prisma.business.findFirst({
    where: { owner: { phone: DEMO_PHONE } },
    select: { id: true, name: true, city: true, province: true },
  });
  if (!demo) throw new Error("demo business (989196421264) not found");
  console.log(`demo buyer: ${demo.name} (${demo.city})`);

  const goodOf = async (nameFa) => {
    const g = await prisma.good.findFirst({ where: { nameFa }, select: { id: true, nameFa: true, unit: true } });
    if (!g) throw new Error(`good not found: ${nameFa}`);
    return g;
  };
  const hashemi = await goodOf("برنج هاشمی");
  const targom = await goodOf("برنج طارم");

  const bizOf = async (name) => {
    const b = await prisma.business.findFirst({ where: { name }, select: { id: true, name: true } });
    if (!b) throw new Error(`business not found: ${name}`);
    return b;
  };
  const saeed = await bizOf("سوپرمارکت سعید");
  const sepid = await bizOf("فروشگاه مواد غذایی سپید");

  // ── ۲) دو فروشنده‌ی جدید (طرح ۱۰/۱۱) — ensure ──
  async function ensureBiz({ slug, name, city, province, trade }) {
    const existing = await prisma.business.findUnique({ where: { slug }, select: { id: true } });
    if (existing) return existing;
    const b = await prisma.business.create({
      data: { slug, name, city, province, trade, country: "IR", currency: "IRR" },
      select: { id: true },
    });
    console.log(`  + BUSINESS ${name} (${city})`);
    return b;
  }
  const gilrang = await ensureBiz({
    slug: "d-gilrang",
    name: "تجارت گیل‌رنج",
    city: "رشت",
    province: "گیلان",
    trade: "پخش مواد غذایی",
  });
  const kian = await ensureBiz({
    slug: "d-kian",
    name: "کیان غلات",
    city: "قزوین",
    province: "قزوین",
    trade: "پخش مواد غذایی",
  });

  // ── ۳) آگهی‌ها (ensure/repair) — اعدادِ طرح ۱۱ ──
  async function ensureListing({ bizId, good, priceMinor, variantLabel, minOrder, stock, msAgo, withLog }) {
    const where = { businessId: bizId, goodId: good.id, variantKey: "" };
    const data = {
      mode: "SELL",
      priceMinor,
      currency: "IRR",
      variantLabel,
      minOrder,
      stock,
      isActive: true,
      city: null,
      province: null,
      updatedAt: iso(msAgo),
    };
    const l = await prisma.listing.upsert({
      where: { businessId_goodId_variantKey: where },
      create: { ...where, ...data },
      update: data,
      select: { id: true },
    });
    if (withLog) {
      // روند ▼ برای کارت تابلو/لیست — فقط یک‌بار (ensure)
      const has = await prisma.priceLog.findFirst({ where: { listingId: l.id }, select: { id: true } });
      if (!has) {
        await prisma.priceLog.create({
          data: { listingId: l.id, oldMinor: withLog.oldMinor, newMinor: priceMinor, createdAt: iso(withLog.msAgo) },
        });
        console.log(`  + PriceLog ${good.nameFa} ▼ از ${withLog.oldMinor.toLocaleString("en")}`);
      }
    }
    return l;
  }
  // گیل‌رنج: هاشمی ۲۷٬۸۰۰٬۰۰۰ (طرح ۱۱: «۲٬۷۸۰٬۰۰۰ تومان ▼ ارزان‌تر از تابلوی شما») — تازه
  await ensureListing({
    bizId: gilrang.id,
    good: hashemi,
    priceMinor: 27_800_000,
    variantLabel: "کیسه ۵۰ کیلویی",
    minOrder: 10,
    stock: 500,
    msAgo: 1 * DAY,
    withLog: { oldMinor: 28_000_000, msAgo: 2 * DAY },
  });
  // کیان: هاشمی گران‌تر (فقط برای چیپ دایرکتوری) + طارم «درجه یک» ۲۶٬۵۰۰٬۰۰۰ (طرح ۱۱)
  await ensureListing({
    bizId: kian.id,
    good: hashemi,
    priceMinor: 29_600_000,
    variantLabel: "کیسه ۵۰ کیلویی",
    minOrder: 10,
    stock: 500,
    msAgo: 4 * DAY,
  });
  await ensureListing({
    bizId: kian.id,
    good: targom,
    priceMinor: 26_500_000,
    variantLabel: "درجه یک — کیسه ۵۰ کیلویی",
    minOrder: 10,
    stock: 500,
    msAgo: 2 * DAY,
  });

  // شمارنده‌ی کاتالوگ denormalized — درست نگه‌داشتن قرارداد اسکیم
  for (const b of [gilrang, kian]) {
    const count = await prisma.listing.count({ where: { businessId: b.id, isActive: true } });
    await prisma.business.update({ where: { id: b.id }, data: { catalogCount: count } });
  }

  // ── ۴) فالوها (ensure) ──
  const pageOf = async (businessId, type) => {
    const pg = await prisma.page.findFirst({ where: { businessId, type }, select: { id: true } });
    if (pg) return pg.id;
    return prisma.page
      .create({ data: { businessId, type }, select: { id: true } })
      .then((r) => r.id);
  };
  const [demoBuy, saeedSell, sepidSell, kianSell] = await Promise.all([
    pageOf(demo.id, "BUY"),
    pageOf(saeed.id, "SELL"),
    pageOf(sepid.id, "SELL"),
    pageOf(kian.id, "SELL"),
  ]);
  // «دنبال‌شده» طرح ۱۰: انزلی (فاز ۶) + سعید + سپید
  for (const sell of [saeedSell, sepidSell]) {
    await prisma.follow.upsert({
      where: { followerPageId_supplierPageId: { followerPageId: demoBuy, supplierPageId: sell } },
      create: { followerPageId: demoBuy, supplierPageId: sell },
      update: {},
    });
  }
  console.log("  + FOLLOW demo(BUY) → سعید(SELL) · سپید(SELL)");
  // «خودش آمد» طرح ۱۰: کیان SELL → demo BUY
  await prisma.follow.upsert({
    where: { followerPageId_supplierPageId: { followerPageId: kianSell, supplierPageId: demoBuy } },
    create: { followerPageId: kianSell, supplierPageId: demoBuy },
    update: {},
  });
  console.log("  + FOLLOW کیان(SELL) → demo(BUY) → «خودش آمد»");

  // ── ۵) راستی‌آزمایی — خروجی باید شبیه طرح ۱۰/۱۱ باشد ──
  const [hashemiBoard, network, answeredInq] = await Promise.all([
    prisma.listing.findMany({
      where: {
        goodId: hashemi.id,
        isActive: true,
        mode: { in: ["SELL", "BOTH"] },
        priceMinor: { not: null },
        businessId: { not: demo.id },
      },
      select: { priceMinor: true, businessId: true, business: { select: { name: true } } },
    }),
    prisma.follow.findMany({
      where: { followerPage: { businessId: demo.id, type: "BUY" } },
      select: { supplierPage: { select: { business: { select: { name: true } } } } },
    }),
    prisma.inquiry.findMany({
      where: { buyerId: demo.id, status: "ANSWERED" },
      select: { seller: { select: { name: true } } },
    }),
  ]);
  const followedNames = network.map((f) => f.supplierPage.business.name);
  const theirsFollows = await prisma.follow.findMany({
    where: { supplierPage: { businessId: demo.id, type: "BUY" }, followerPage: { type: "SELL" } },
    select: { followerPage: { select: { business: { select: { name: true } } } } },
  });

  console.log(`\nVERIFY — طرح ۱۰ (دایرکتوری):`);
  console.log(`  دنبال‌شده (mine): ${followedNames.join(" · ")} — انتظار: انزلی، سعید، سپید`);
  console.log(`  خودش آمد (theirs): ${theirsFollows.map((t) => t.followerPage.business.name).join(" · ")} — انتظار: کیان غلات`);
  console.log(`  خریده‌ام از او (ANSWERED): ${answeredInq.map((a) => a.seller.name).join(" · ")} — انتظار: نگین، سعید`);

  console.log(`\nVERIFY — طرح ۱۱ (پیشنهادها) — تابلوی هاشمی:`);
  hashemiBoard.sort((a, b) => a.priceMinor - b.priceMinor);
  for (const r of hashemiBoard) {
    const inNet = followedNames.includes(r.business.name) ? "[شبکه]" : "";
    console.log(`  ${r.business.name} — ${(r.priceMinor / 10).toLocaleString("en")} تومان ${inNet}`);
  }
  const boardBest = Math.min(
    ...hashemiBoard.filter((r) => followedNames.includes(r.business.name)).map((r) => r.priceMinor)
  );
  const gilrangRow = hashemiBoard.find((r) => r.businessId === gilrang.id);
  if (gilrangRow && boardBest) {
    const pct = Math.round(((boardBest - gilrangRow.priceMinor) / boardBest) * 100);
    console.log(
      `  کارت «قیمت بهتر»: گیل‌رنج ${(gilrangRow.priceMinor / 10).toLocaleString("en")} تومان — ▼${pct}٪ ارزان‌تر از ${(
        boardBest / 10
      ).toLocaleString("en")} (بهترین شبکه) — انتظار: ۲٬۷۸۰٬۰۰۰ / ▼۲٪`
    );
  }
  console.log(
    `  کارت «جایگزین»: طارم ${(26_500_000 / 10).toLocaleString("en")} تومان (کیان) < ارزان‌ترین هاشمی — انتظار: ۲٬۶۵۰٬۰۰۰`
  );
  console.log(`  کارت «تأمین‌کننده جدید»: سوپرمارکت ماهان (روغن، بدون استعلام، خارج از شبکه)`);
}

main()
  .catch((e) => {
    console.error("SEED FAILED:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
