/*
 * Phase 8 seed — دموی «واقعی» برای پروفایل دو-بازویی (طرح ۰۷/۱۴)
 * کاربر دمو: 989196421264 (پخش برنج پارس، رشت) — هر دو بازو را دارد.
 * ۱) بازدید ماهِ کاتالوگ به سطح طرح ۰۷ (≈۱۲۰) بالا می‌رود — توزیع واقعی روی ردیف‌ها
 * ۲) تنظیمات اعلان دقیقاً حالت طرح ۱۴: تغییر قیمت ✓ · پیشنهاد iMach ✓ ·
 *    پاسخ درخواست‌ها ✗ (خاموش) · پوش ✓
 * Idempotent — دوباره اجرا فقط مقادیر را همان‌جا تنظیم می‌کند.
 * اجرا: node scripts/phase8-seed-demo.js
 */
require("dotenv").config();
if (process.env.MONGO_URL) process.env.DATABASE_URL = process.env.MONGO_URL;
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const DEMO_PHONE = "989196421264";

/** توزیع بازدیدِ هدف (جمع ≈ ۱۲۰ مثل طرح ۰۷) — نسبت‌ها از داده‌ی فعلی */
const VIEW_TARGETS = [
  { nameFa: "برنج هاشمی", v30: 42 },
  { nameFa: "برنج طارم", v30: 34 },
  { nameFa: "برنج فجر", v30: 24 },
  { nameFa: "برنج صدری", v30: 12 },
];

async function main() {
  const demo = await prisma.business.findFirst({
    where: { owner: { phone: DEMO_PHONE } },
    select: { id: true, name: true, slug: true },
  });
  if (!demo) throw new Error("demo business not found");
  console.log(`DEMO: ${demo.name}`);

  // ── ۱) بازدید ماه (طرح ۰۷: «۱۲۰ بازدید ماه») ──
  const sellListings = await prisma.listing.findMany({
    where: { businessId: demo.id, mode: { in: ["SELL", "BOTH"] }, isActive: true },
    select: { id: true, viewCount30: true, viewCountTotal: true, good: { select: { nameFa: true } } },
  });
  // فقط اولین ردیفِ هر نام کالا هدف می‌گیرد؛ ردیف دوم (هاشمیِ دوم) سهم کوچکی
  const perGood = new Map();
  for (const t of VIEW_TARGETS) perGood.set(t.nameFa, 0);
  for (const l of sellListings) {
    const t = VIEW_TARGETS.find((x) => x.nameFa === l.good.nameFa);
    if (!t) continue;
    const seen = perGood.get(t.nameFa) ?? 0;
    if (seen === 0) {
      await prisma.listing.update({
        where: { id: l.id },
        data: {
          viewCount30: t.v30,
          viewCountTotal: Math.max(l.viewCountTotal ?? 0, t.v30 + 8),
        },
      });
      perGood.set(t.nameFa, 1);
      console.log(`  ${l.good.nameFa}: viewCount30 ${l.viewCount30 ?? 0} → ${t.v30}`);
    }
  }
  // هاشمیِ دوم — ۸٪ از بازدید اولی (رشد واقعی ردیف تازه)
  const hashemis = sellListings.filter((l) => l.good.nameFa === "برنج هاشمی");
  if (hashemis.length > 1) {
    const l = hashemis[1];
    await prisma.listing.update({
      where: { id: l.id },
      data: {
        viewCount30: 8,
        viewCountTotal: Math.max(l.viewCountTotal ?? 0, 16),
      },
    });
    console.log(`  ${l.good.nameFa} (ردیف دوم): viewCount30 → 8`);
  }

  // ── ۲) تنظیمات اعلان = حالت طرح ۱۴ (روشن/روشن/خاموش/روشن) ──
  const prefs = { priceChange: true, suggestions: true, quoteReplies: false, push: true };
  await prisma.business.update({ where: { id: demo.id }, data: { notifPrefs: prefs } });
  console.log(`  notifPrefs → ${JSON.stringify(prefs)}`);

  // ── گزارش نهایی (همان چیزی که پروفایل نشان می‌دهد) ──
  const [finalListings, customers, watched, follows, inquiries, offers] = await Promise.all([
    prisma.listing.findMany({
      where: { businessId: demo.id, mode: { in: ["SELL", "BOTH"] }, isActive: true },
      select: { viewCount30: true },
    }),
    prisma.follow.findMany({ where: { supplierPage: { businessId: demo.id, type: "SELL" } }, select: { id: true } }),
    prisma.watchedGood.findMany({ where: { businessId: demo.id }, select: { id: true } }),
    prisma.follow.findMany({ where: { followerPage: { businessId: demo.id, type: "BUY" } }, select: { id: true } }),
    prisma.inquiry.findMany({ where: { buyerId: demo.id }, select: { listingId: true, sellerId: true } }),
    prisma.offer.findMany({ where: { buyerId: demo.id }, select: { listingId: true, sellerId: true } }),
  ]);
  const offerKey = new Set(offers.map((o) => `${o.listingId}:${o.sellerId}`));
  const open = inquiries.filter((i) => !offerKey.has(`${i.listingId}:${i.sellerId}`)).length;
  console.log(`\nPROFILE (sell): ${finalListings.length} کالا · ${finalListings.reduce((s, l) => s + (l.viewCount30 ?? 0), 0)} بازدید ماه · ${customers.length} مشتری`);
  console.log(`PROFILE (buy): ${watched.length}+BUY کالا · ${follows.length}+theirs تأمین‌کننده · ${open} درخواست باز`);
}

main()
  .catch((e) => {
    console.error("SEED FAILED:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
