/*
 * Phase 5 demo seed — لیست خرید + دنبال‌کردن قیمت (design-reference/screens/08)
 *
 * نوشتن داده‌ی «واقعی» دیتابیس برای کاربر دمو 989196421264 (پخش برنج پارس، در نقش خریدار):
 *   • ۶ آگهی فروش از ۶ کسب‌وکار موجود → تابلوی تأمین سه کالا (۳/۲/۱ تامین‌کننده)
 *   • ۲ PriceLog → روند ▼۲٪ هاشمی / ▲۵٪ روغن (چیپ «تغییر قیمت» = ۲)
 *   • ۴ آگهی خرید خودِ دمو (حجم/دوره → «ماهانه · ۲۰ کیسه») — قند بدون تابلوبان → ردیف خط‌چین + CTA «دنبال کردن»
 *   • ۳ WatchedGood (هاشمی/روغن/رب) — قند عمداً دنبال‌نشده تا CTA کار کند
 *   • ۳ درخواست قیمت فرستاده‌شده (۲ پاسخ‌گرفته + ۱ جدید) → بج «درخواست‌های من» = ۲
 * همه‌ی ارجاع‌ها به گود/کسب‌وکارهای موجودِ دیتابیس‌اند — هیچ چیز ماگ نیست.
 *
 * مهاجرت BUY→WatchedGood (گزینه‌ی کم‌ریسک): هر BUY listing فعالِ هر کسب‌وکاری
 * یک WatchedGood هم‌گود می‌گیرد (فهرست خرید = WATCH ∪ BUY؛ حجم/دوره از BUY می‌ماند).
 *
 * Ensure/Repair: هر اجرا وضعیت دمو را «درست» می‌کند؛ اجرای دوباره بی‌ضرر است.
 * Rollback: scripts/backups/phase5-pre-watch-2026-10-01/ (dump پیش از schema push)
 *
 * اجرا: DATABASE_URL="$MONGO_URL" node scripts/phase5-seed-demo.js
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const DEMO_PHONE = "989196421264";
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo);

async function main() {
  // ── ۱) خریدارِ دمو (پخش برنج پارس) ──
  const demo = await prisma.business.findFirst({
    where: { owner: { phone: DEMO_PHONE } },
    select: { id: true, name: true, slug: true, city: true },
  });
  if (!demo) throw new Error("demo business (989196421264) not found");
  console.log(`demo buyer: ${demo.name} (${demo.id})`);

  // گودهای طرح — همه در کاتالوگ مرجع موجودند
  const goodOf = async (nameFa) => {
    const g = await prisma.good.findFirst({ where: { nameFa }, select: { id: true, nameFa: true, unit: true } });
    if (!g) throw new Error(`good not found: ${nameFa}`);
    return g;
  };
  const hashemi = await goodOf("برنج هاشمی");
  const oil = await goodOf("روغن سرخ‌کردنی");
  const paste = await goodOf("رب گوجه‌فرنگی");
  const sugar = await goodOf("قند");

  // ── ۲) تامین‌کننده‌ها — آگهی فروش فعال روی همان گودها (ensure) ──
  const bizOf = async (name) => {
    const b = await prisma.business.findFirst({ where: { name }, select: { id: true, name: true, city: true } });
    if (!b) throw new Error(`business not found: ${name}`);
    return b;
  };
  const negin = await bizOf("پخش نگین"); // قزوین
  const anzali = await bizOf("پخش مواد غذایی انزلی"); // رشت
  const parsGhaza = await bizOf("پخش پارس‌غذا"); // تهران
  const saeed = await bizOf("سوپرمارکت سعید"); // رشت
  const mahan = await bizOf("سوپرمارکت ماهان"); // رشت
  const sepid = await bizOf("فروشگاه مواد غذایی سپید"); // رشت

  /** آگهی فروش ensure — کلید یکتا (businessId, goodId, variantKey) */
  async function ensureSell(bizId, good, variantLabel, priceMinor, minOrder) {
    const found = await prisma.listing.findFirst({
      where: { businessId: bizId, goodId: good.id, mode: "SELL", variantKey: "" },
      select: { id: true, priceMinor: true, isActive: true },
    });
    if (!found) {
      const l = await prisma.listing.create({
        data: {
          businessId: bizId,
          goodId: good.id,
          mode: "SELL",
          variantKey: "",
          variantLabel,
          priceMinor,
          currency: "IRR",
          minOrder,
          stock: 500,
          isActive: true,
        },
        select: { id: true },
      });
      console.log(`  + SELL ${good.nameFa} — ${priceMinor} (${variantLabel})`);
      return l.id;
    }
    if (!found.isActive || found.priceMinor !== priceMinor) {
      await prisma.listing.update({
        where: { id: found.id },
        data: { isActive: true, priceMinor },
      });
      console.log(`  ~ SELL repaired ${good.nameFa} → ${priceMinor}`);
    }
    return found.id;
  }

  // طرح ۰۸: «۳ تأمین‌کننده» هاشمی — ارزان‌ترین ۲٬۸۵۰٬۰۰۰ تومان (انزلی)
  const lNegin = await ensureSell(negin.id, hashemi, "کیسه ۵۰ کیلویی", 29500000, 10);
  const lAnzali = await ensureSell(anzali.id, hashemi, "کیسه ۵۰ کیلویی", 28500000, 20);
  const lParsGhaza = await ensureSell(parsGhaza.id, hashemi, "کیسه ۵۰ کیلویی", 29000000, 10);
  // «۲ تأمین‌کننده» روغن — ارزان‌ترین ۵۱۰٬۰۰۰ تومان (سعید)
  const lSaeedOil = await ensureSell(saeed.id, oil, "گالن ۱۰ لیتری", 5100000, 24);
  const lMahanOil = await ensureSell(mahan.id, oil, "گالن ۱۰ لیتری", 5250000, 12);
  // «۱ تامین‌کننده» رب — تنها قیمت ۹۸٬۰۰۰ تومان (سپید)
  const lSepidPaste = await ensureSell(sepid.id, paste, "بسته ۵۰۰ گرمی", 980000, 12);

  // ── ۳) تاریخچه قیمت — روند هفتگی و چیپ «تغییر قیمت» ──
  async function ensurePriceLog(listingId, oldMinor, newMinor, msAgo) {
    const found = await prisma.priceLog.findFirst({ where: { listingId }, select: { id: true } });
    if (found) return;
    await prisma.priceLog.create({ data: { listingId, oldMinor, newMinor, createdAt: iso(msAgo) } });
    console.log(`  + PriceLog ${listingId.slice(-6)}: ${oldMinor} → ${newMinor}`);
  }
  // هاشمی: ۲,۹۱۰,۰۰۰ → ۲,۸۵۰,۰۰۰ (۳ روز پیش) → «▼ ۲٪ این هفته»
  await ensurePriceLog(lAnzali, 29100000, 28500000, 3 * DAY - 2 * 3600 * 1000);
  // روغن: ۴۸۶,۰۰۰ → ۵۱۰,۰۰۰ (۵ روز پیش) → «▲ ۵٪ این هفته»
  await ensurePriceLog(lSaeedOil, 4860000, 5100000, 5 * DAY - 4 * 3600 * 1000);

  // ── ۴) آگهی خرید دمو — منبع حجم/دوره‌ی ردیف‌ها («ماهانه · ۲۰ کیسه») ──
  async function ensureBuy(good, variantLabel, volume, frequency) {
    const found = await prisma.listing.findFirst({
      where: { businessId: demo.id, goodId: good.id, mode: "BUY", variantKey: "need" },
      select: { id: true, volume: true, frequency: true, isActive: true },
    });
    if (!found) {
      await prisma.listing.create({
        data: {
          businessId: demo.id,
          goodId: good.id,
          mode: "BUY",
          variantKey: "need",
          variantLabel,
          volume,
          frequency,
          isActive: true,
          city: demo.city,
          province: "گیلان",
          country: "IR",
        },
      });
      console.log(`  + BUY ${good.nameFa} — ${volume} (${frequency})`);
    } else if (found.volume !== volume || found.frequency !== frequency || !found.isActive) {
      await prisma.listing.update({
        where: { id: found.id },
        data: { volume, frequency, isActive: true },
      });
    }
  }
  await ensureBuy(hashemi, "کیسه ۵۰ کیلویی", 20, "MONTHLY");
  await ensureBuy(oil, "گالن ۱۰ لیتری", 40, "MONTHLY");
  await ensureBuy(paste, "بسته ۵۰۰ گرمی", 60, "WEEKLY");
  await ensureBuy(sugar, "پاکت ۹۰۰ گرمی", 30, "MONTHLY");

  // ── ۵) WatchedGoodهای دمو — قند عمداً دنبال‌نشده (CTA «دنبال کردن») ──
  async function ensureWatch(bizId, good, msAgo) {
    const found = await prisma.watchedGood.findUnique({
      where: { businessId_goodId: { businessId: bizId, goodId: good.id } },
      select: { id: true },
    });
    if (found) return;
    await prisma.watchedGood.create({
      data: { businessId: bizId, goodId: good.id, createdAt: iso(msAgo) },
    });
    console.log(`  + WATCH ${good.nameFa}`);
  }
  await ensureWatch(demo.id, hashemi, 12 * DAY);
  await ensureWatch(demo.id, oil, 9 * DAY);
  await ensureWatch(demo.id, paste, 6 * DAY);

  // ── ۶) «درخواست‌های من» — ۳ استعلام فرستاده (۲ پاسخ + ۱ باز) ──
  async function ensureMyInquiry(sellerBiz, listingId, volume, frequency, status, msAgo) {
    const found = await prisma.inquiry.findFirst({
      where: { buyerId: demo.id, sellerId: sellerBiz.id, listingId, volume },
      select: { id: true, status: true },
    });
    if (!found) {
      await prisma.inquiry.create({
        data: {
          buyerId: demo.id,
          sellerId: sellerBiz.id,
          listingId,
          volume,
          frequency,
          status,
          isRead: true,
          createdAt: iso(msAgo),
        },
      });
      console.log(`  + INQ → ${sellerBiz.name} (${status})`);
    } else if (found.status !== status) {
      await prisma.inquiry.update({ where: { id: found.id }, data: { status } });
    }
  }
  await ensureMyInquiry(negin, lNegin, 20, "MONTHLY", "ANSWERED", 6 * DAY);
  await ensureMyInquiry(saeed, lSaeedOil, 40, "MONTHLY", "ANSWERED", 4 * DAY);
  await ensureMyInquiry(sepid, lSepidPaste, 60, "WEEKLY", "NEW", 1 * DAY);

  // پاسخ‌های دریافتی برای درخواست‌های «پاسخ‌گرفته»
  async function ensureAnswer(sellerBiz, listingId, priceMinor, note, msAgo) {
    const found = await prisma.offer.findFirst({
      where: { buyerId: demo.id, sellerId: sellerBiz.id, listingId },
      select: { id: true },
    });
    if (found) return;
    await prisma.offer.create({
      data: {
        buyerId: demo.id,
        sellerId: sellerBiz.id,
        listingId,
        priceMinor,
        currency: "IRR",
        minOrder: 10,
        score: 0,
        isSpecial: false,
        note,
        createdAt: iso(msAgo),
      },
    });
    console.log(`  + ANSWER ${sellerBiz.name}: ${priceMinor}`);
  }
  await ensureAnswer(negin, lNegin, 29200000, "کیفیت درجه یک — ارسال از قزوین، بارگیری همان روز", 5 * DAY);
  await ensureAnswer(saeed, lSaeedOil, 5000000, "گالن ۱۰ لیتری اصل — تخفیف پاکت ۲۴تایی", 3 * DAY);

  // ── ۷) مهاجرت BUY→WatchedGood (یک‌باره، کم‌ریسک) — همه‌ی BUYهای فعال ──
  const buys = await prisma.listing.findMany({
    where: { mode: { in: ["BUY", "BOTH"] }, isActive: true },
    select: { businessId: true, goodId: true },
  });
  let migrated = 0;
  for (const b of buys) {
    const found = await prisma.watchedGood.findUnique({
      where: { businessId_goodId: { businessId: b.businessId, goodId: b.goodId } },
      select: { id: true },
    });
    if (!found) {
      await prisma.watchedGood.create({ data: { businessId: b.businessId, goodId: b.goodId } });
      migrated++;
    }
  }
  console.log(`  ~ migration: ${migrated} BUY listing(s) → WatchedGood`);

  // قند در طرح ۰۸ دنبال‌نشده می‌ماند — ردیف خط‌چین با CTA «دنبال کردن».
  // (مهاجرتِ بالا آن را دنبال کرده بود؛ دمو عمداً خاموشش می‌کند تا CTA واقعی دیده شود)
  await prisma.watchedGood.deleteMany({ where: { businessId: demo.id, goodId: sugar.id } });

  // ── ۸) راستی‌آزمایی (طرح ۰۸) ──
  const [watched, boards, logs, myInq, myAnswers] = await Promise.all([
    prisma.watchedGood.count({ where: { businessId: demo.id } }),
    Promise.all([
      prisma.listing.count({ where: { goodId: hashemi.id, mode: "SELL", isActive: true, businessId: { not: demo.id }, priceMinor: { not: null } } }),
      prisma.listing.count({ where: { goodId: oil.id, mode: "SELL", isActive: true, businessId: { not: demo.id }, priceMinor: { not: null } } }),
      prisma.listing.count({ where: { goodId: paste.id, mode: "SELL", isActive: true, businessId: { not: demo.id }, priceMinor: { not: null } } }),
      prisma.listing.count({ where: { goodId: sugar.id, mode: "SELL", isActive: true, businessId: { not: demo.id }, priceMinor: { not: null } } }),
    ]),
    prisma.priceLog.count(),
    prisma.inquiry.count({ where: { buyerId: demo.id } }),
    prisma.inquiry.count({ where: { buyerId: demo.id, status: "ANSWERED" } }),
  ]);
  console.log(
    `\nVERIFY: watched=${watched} (expect 3) | board hashemi/oil/paste/sugar=${boards.join("/")} (expect 3/2/1/0) | priceLogs=${logs} (expect 2) | myInquiries=${myInq} (expect 3) | answered=${myAnswers} (expect 2)`
  );
}

main()
  .catch((e) => {
    console.error("SEED FAILED:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
