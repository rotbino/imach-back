/*
 * Phase 6 demo seed — تابلوی تأمین + فرم درخواست قیمت (design-reference/screens/09 + 12)
 *
 * نوشتن داده‌ی «واقعی» برای کاربر دمو 989196421264 (پخش برنج پارس، خریدار):
 *   • فالوی انزلی (ارزان‌ترین هاشمی) → دکمه‌ی تیک سبز + چیپ «دنبال می‌کنم» در تابلو (طرح ۰۹)
 *   • تازگیِ متنوعِ آگهی‌ها: «به‌روزرسانی ۳/۵/۱۱ روز پیش» مثل طرح ۰۹
 *   • سابقه‌ی خرید از نگین (فاز ۵) → چیپ سبز «از او خریده‌ام» (تولید عمدی دوباره، ساختار مستقل)
 *   • زمینه‌ی فرم ۱۲: حجم ۲۰ + ماهانه + کیسه ۵۰ کیلویی (BUY listing فاز ۵)
 * Ensure/Repair: هر اجرا وضعیت دمو را «درست» می‌کند؛ اجرای دوباره بی‌ضرر است.
 *
 * اجرا: DATABASE_URL="$MONGO_URL" node scripts/phase6-seed-demo.js
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const DEMO_PHONE = "989196421264";
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo);

async function main() {
  // ── ۱) خریدارِ دمو + تأمین‌کننده‌های تابلوی هاشمی ──
  const demo = await prisma.business.findFirst({
    where: { owner: { phone: DEMO_PHONE } },
    select: { id: true, name: true, city: true },
  });
  if (!demo) throw new Error("demo business (989196421264) not found");
  console.log(`demo buyer: ${demo.name} (${demo.city})`);

  const goodOf = async (nameFa) => {
    const g = await prisma.good.findFirst({ where: { nameFa }, select: { id: true, nameFa: true } });
    if (!g) throw new Error(`good not found: ${nameFa}`);
    return g;
  };
  const hashemi = await goodOf("برنج هاشمی");
  const oil = await goodOf("روغن سرخ‌کردنی");
  const paste = await goodOf("رب گوجه‌فرنگی");

  const bizOf = async (name) => {
    const b = await prisma.business.findFirst({ where: { name }, select: { id: true, name: true } });
    if (!b) throw new Error(`business not found: ${name}`);
    return b;
  };
  const anzali = await bizOf("پخش مواد غذایی انزلی"); // رشت — ارزان‌ترین هاشمی
  const negin = await bizOf("پخش نگین"); // قزوین
  const parsGhaza = await bizOf("پخش پارس‌غذا"); // تهران
  const saeed = await bizOf("سوپرمارکت سعید");
  const mahan = await bizOf("سوپرمارکت ماهان");
  const sepid = await bizOf("فروشگاه مواد غذایی سپید");

  // ── ۲) تازگیِ آگهی‌ها — «به‌روزرسانی ۳/۵/۱۱ روز پیش» (متن طرح ۰۹) ──
  async function setFreshness(bizId, good, msAgo) {
    const l = await prisma.listing.findFirst({
      where: { businessId: bizId, goodId: good.id, mode: "SELL" },
      select: { id: true, updatedAt: true },
    });
    if (!l) throw new Error(`listing not found: ${bizId} × ${good.nameFa}`);
    // فقط اگر خیلی تازه است دورش بزنیم — تازگی «پیر» طرح لازم است؛ پرش رندر عادی
    if (Math.abs(now - l.updatedAt.getTime()) < 6 * 3600 * 1000 || l.updatedAt.getTime() > now - msAgo + 3600 * 1000) {
      await prisma.listing.update({ where: { id: l.id }, data: { updatedAt: iso(msAgo) } });
      console.log(`  ~ fresh ${good.nameFa} @ ${msAgo / DAY}d — ${bizId.slice(-4)}`);
    }
  }
  // طرح ۰۹: ارزان‌ترین ۳ روز پیش · دومی ۵ روز پیش · سومی ۱۱ روز پیش
  await setFreshness(anzali.id, hashemi, 3 * DAY);
  await setFreshness(parsGhaza.id, hashemi, 5 * DAY);
  await setFreshness(negin.id, hashemi, 11 * DAY);
  await setFreshness(saeed.id, oil, 2 * DAY);
  await setFreshness(mahan.id, oil, 8 * DAY);
  await setFreshness(sepid.id, paste, 4 * DAY);

  // ── ۳) فالوی انزلی از میز خرید دمو — تیک سبز طرح ۰۹ ──
  const [buyPage, sellPage] = await Promise.all([
    prisma.page.findFirst({ where: { businessId: demo.id, type: "BUY" }, select: { id: true } }),
    prisma.page.findFirst({ where: { businessId: anzali.id, type: "SELL" }, select: { id: true } }),
  ]);
  if (!buyPage || !sellPage) throw new Error("BUY/SELL page not found — run phase5 seed first");
  await prisma.follow.upsert({
    where: { followerPageId_supplierPageId: { followerPageId: buyPage.id, supplierPageId: sellPage.id } },
    create: { followerPageId: buyPage.id, supplierPageId: sellPage.id },
    update: {},
  });
  console.log("  + FOLLOW demo(BUY) → انزلی(SELL)");

  // ── ۴) راستی‌آزمایی تابلوی هاشمی برای دمو (خروجی باید شبیه طرح ۰۹ باشد) ──
  const rows = await prisma.listing.findMany({
    where: {
      goodId: hashemi.id,
      isActive: true,
      mode: { in: ["SELL", "BOTH"] },
      priceMinor: { not: null },
      businessId: { not: demo.id },
    },
    select: {
      priceMinor: true,
      minOrder: true,
      variantLabel: true,
      updatedAt: true,
      business: { select: { id: true, name: true, city: true } },
      priceLogs: { orderBy: { createdAt: "desc" }, take: 1, select: { oldMinor: true } },
    },
  });
  const [followRows, inqRows, myBuy] = await Promise.all([
    prisma.follow.findMany({
      where: { followerPage: { businessId: demo.id, type: "BUY" } },
      select: { supplierPage: { select: { businessId: true } } },
    }),
    prisma.inquiry.findMany({
      where: { buyerId: demo.id, listing: { goodId: hashemi.id } },
      select: { sellerId: true },
    }),
    prisma.listing.findFirst({
      where: { businessId: demo.id, goodId: hashemi.id, mode: { in: ["BUY", "BOTH"] }, isActive: true },
      select: { volume: true, frequency: true },
    }),
  ]);
  const followed = new Set(followRows.map((f) => f.supplierPage.businessId));
  const bought = new Set(inqRows.map((i) => i.sellerId));

  console.log(`\nVERIFY — تابلوی برنج هاشمی (${rows.length} ردیف، انتظار ۳):`);
  for (const r of rows.sort((a, b) => a.priceMinor - b.priceMinor)) {
    const days = Math.floor((now - r.updatedAt.getTime()) / DAY);
    console.log(
      `  ${r.business.name} (${r.business.city}) — ${r.priceMinor.toLocaleString("en")} ر` +
        ` · ${r.variantLabel ?? ""} · حداقل ${r.minOrder ?? "—"}` +
        ` · ${days} روز پیش${r.priceLogs[0] ? ` · ▼از ${r.priceLogs[0].oldMinor.toLocaleString("en")}` : ""}` +
        (followed.has(r.business.id) ? " · دنبال می‌کنم" : "") +
        (bought.has(r.business.id) ? " · از او خریده‌ام" : "")
    );
  }
  console.log(
    `زمینه‌ی فرم ۱۲: حجم=${myBuy?.volume} (انتظار 20) · دوره=${myBuy?.frequency} (انتظار MONTHLY) · فالو=${followed.size} (انتظار ≥1)`
  );
  const oilRows = await prisma.listing.count({
    where: { goodId: oil.id, isActive: true, mode: "SELL", priceMinor: { not: null }, businessId: { not: demo.id } },
  });
  const pasteRows = await prisma.listing.count({
    where: { goodId: paste.id, isActive: true, mode: "SELL", priceMinor: { not: null }, businessId: { not: demo.id } },
  });
  console.log(`تابلوی روغن=${oilRows} (انتظار 2) · تابلوی رب=${pasteRows} (انتظار 1)`);
}

main()
  .catch((e) => {
    console.error("SEED FAILED:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
