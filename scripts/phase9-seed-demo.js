/*
 * Phase 9 demo seed — بازسازی دنیای دمو به «زنجیره‌ی برنج» (خواسته‌ی کاربر):
 *
 *   پاک‌سازی:
 *   • سوپرمارکت‌ها و خرده‌فروش‌های مواد غذایی (۹ سوپرمارکت + به‌سازان + سپید +
 *     فروشگاه خانگی + بقالی نوید) با «تمام موارد مربوط به اونا»:
 *     listings/pages/follows/watched/inquiries/offers/notifications/pricelogs
 *
 *   زنجیره‌ی برنج (همه با داده‌ی واقعی روی کالاهای مرجع موجود):
 *   • کشاورز:   مزرعه برنج سراوان (فومن) — فروش هاشمی/طارم با حداقل‌سفارش ۱۰ تن
 *   • بنکدار:   بنکداری برنج گیل (رشت) — فروش عمده ۲۰تن+ / خرید ۱۰۰ تن در ماه
 *   • پخش‌ها:   پارس(دِمو، خرید ۱۰۰۰ کیسه=۵۰تن) + انزلی/گیل‌رنج/کیان/نگین (خرید سنگین)
 *   • خریداران: رستوران‌ها (کاتالوگ غذای گرم: چلوکباب/چلومرغ) + تالارها + هتل‌ها
 *   • تالار/هتل فقط دستیار خرید دارند (enabledArms={sell:false,buy:true}) —
 *     سوییچر بالای فرم‌ها برایشان غیب می‌شود
 *
 *   کاربران دمو (همه رمز 123456):
 *   09196421264 پخش برنج پارس (تامین‌کننده) · 09111111111 مزرعه سراوان (کشاورز)
 *   09122222222 بنکداری برنج گیل · 09133333333 رستوران دیوان
 *   09144444444 تالار مجلل نیایش · 09155555555 هتل رستوران نفت
 *
 * Ensure/Repair: هر اجرا وضعیت را «درست» می‌کند؛ اجرای دوباره بی‌ضرر است.
 * بکاپ: scripts/backups/phase9-pre-ricechain-<ts>/ (JSON کاملِ قبل از پاک‌سازی)
 * اجرا: node scripts/phase9-seed-demo.js
 */
require("dotenv").config();
if (process.env.MONGO_URL) process.env.DATABASE_URL = process.env.MONGO_URL;
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const prisma = new PrismaClient();

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo);
const PASSWORD = "123456";
const log = (...a) => console.log(" ", ...a);

// ─── ثابت‌های دیتای جدید ───
const RICE_HASHEMI = "6abe2511578b46707877ed0f";
const RICE_TAROM = "6abc083735cb2b8c905c0af5";
const RICE_FAJR = "6abc083935cb2b8c905c0af9";
const RICE_SADRI = "6abe2511578b46707877ed10";
const OIL = "6abac99faa4827c157c85489"; // روغن سرخ‌کردنی
const PASTE = "6abab15058f8b701f3c17490"; // رب گوجه‌فرنگی
const SUGAR = "6abab16658f8b701f3c1751c"; // سایر قند، شکر و چای
const SEED_RICE = "6abc20bb6e27175768722146"; // بذر برنج
const FOOD_CAT = "6ab3aa2c7241dfd74d29fc50"; // مواد غذایی و آشامیدنی (ریشه)

/** نام‌هایی که باید پاک شوند — خرده‌فروشی مواد غذایی (مثالِ بدِ کاربر) */
const DELETE_TRADES_EXACT = ["سوپرمارکت", "فروشگاه زنجیره‌ای", "فروشگاه مواد غذایی", "بقالی"];
/** به‌علاوه‌ی این‌های خاص با نام */
const DELETE_NAMES = ["فروشگاه خانگی"];

async function main() {
  /* ═══ ۰) بکاپ کامل قبل از هر تغییری ═══ */
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const backupDir = path.join(__dirname, "backups", `phase9-pre-ricechain-${ts}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const bizs = await prisma.business.findMany({
    select: {
      id: true, slug: true, name: true, trade: true, city: true, phone: true, isDemo: true,
      owner: { select: { phone: true } },
    },
  });

  /* ═══ ۱) حذف خرده‌فروش‌های مواد غذایی + هر آنچه به ایشان وابسته است ═══ */
  const victims = bizs.filter(
    (b) =>
      DELETE_TRADES_EXACT.includes((b.trade ?? "").trim()) ||
      DELETE_NAMES.includes(b.name.trim())
  );
  console.log(`\n[1] حذف ${victims.length} خرده‌فروش مواد غذایی:`, victims.map((v) => v.name).join(" · "));
  const victimIds = victims.map((v) => v.id);
  const victimSlugs = victims.map((v) => v.slug);
  const victimPages = await prisma.page.findMany({ where: { businessId: { in: victimIds } }, select: { id: true } });
  const victimPageIds = victimPages.map((p) => p.id);

  // بکاپ هر ردیفی که قرار است حذف شود
  const bListings = await prisma.listing.findMany({ where: { businessId: { in: victimIds } } });
  const bFollows = await prisma.follow.findMany({
    where: { OR: [{ followerPageId: { in: victimPageIds } }, { supplierPageId: { in: victimPageIds } }] },
  });
  const bWatched = await prisma.watchedGood.findMany({ where: { businessId: { in: victimIds } } });
  const bInq = await prisma.inquiry.findMany({ where: { OR: [{ buyerId: { in: victimIds } }, { sellerId: { in: victimIds } }] } });
  const bOffers = await prisma.offer.findMany({ where: { OR: [{ buyerId: { in: victimIds } }, { sellerId: { in: victimIds } }] } });
  const bNotifs = await prisma.notification.findMany({ where: { actorSlug: { in: victimSlugs } } });
  const bLogs = await prisma.priceLog.findMany({
    where: { listing: { businessId: { in: victimIds } } },
  });
  fs.writeFileSync(path.join(backupDir, "deleted.json"), JSON.stringify({
    businesses: victims, listings: bListings, follows: bFollows, watched: bWatched,
    inquiries: bInq, offers: bOffers, notifications: bNotifs, priceLogs: bLogs,
  }, null, 2));
  log(`backup → ${backupDir}/deleted.json (${bListings.length} listings, ${bFollows.length} follows, ${bInq.length} inquiries)`);

  // حذف — اول ردیف‌های وابسته، بعد خودِ کسب‌وکار
  if (bLogs.length) await prisma.priceLog.deleteMany({ where: { id: { in: bLogs.map((x) => x.id) } } });
  if (bOffers.length) await prisma.offer.deleteMany({ where: { id: { in: bOffers.map((x) => x.id) } } });
  if (bInq.length) await prisma.inquiry.deleteMany({ where: { id: { in: bInq.map((x) => x.id) } } });
  if (bNotifs.length) await prisma.notification.deleteMany({ where: { id: { in: bNotifs.map((x) => x.id) } } });
  if (bWatched.length) await prisma.watchedGood.deleteMany({ where: { id: { in: bWatched.map((x) => x.id) } } });
  if (bFollows.length) await prisma.follow.deleteMany({ where: { id: { in: bFollows.map((x) => x.id) } } });
  if (bListings.length) await prisma.listing.deleteMany({ where: { id: { in: bListings.map((x) => x.id) } } });
  await prisma.page.deleteMany({ where: { businessId: { in: victimIds } } });
  await prisma.business.deleteMany({ where: { id: { in: victimIds } } });
  log(`حذف شد: ${victims.length} کسب‌وکار + ${bListings.length} آگهی + ${bFollows.length} فالو + ${bWatched.length} واچ + ${bInq.length} استعلام + ${bOffers.length} پیشنهاد + ${bNotifs.length} اعلان + ${bLogs.length} PriceLog`);

  /* ═══ ۲) کاربران دمو — همه با رمز 123456 ═══ */
  console.log("\n[2] کاربران دمو (رمز 123456)");
  const pwHash = await bcrypt.hash(PASSWORD, 10);
  const USERS = [
    { phone: "989196421264", firstName: "سعید", lastName: "یوسفی", attach: "پخش برنج پارس" },
    { phone: "989111111111", firstName: "صادق", lastName: "رشیدی", attach: null }, // مزرعه — بیز جدید
    { phone: "989222222222", firstName: "محرم", lastName: "یوسفی", attach: null }, // بنکدار — بیز جدید
    { phone: "989333333333", firstName: "مهدی", lastName: "دیوانی", attach: "رستوران دیوان" },
    { phone: "989444444444", firstName: "سارا", lastName: "محمدی", attach: null }, // تالار — بیز جدید
    { phone: "989155555555", firstName: "فرهاد", lastName: "امیری", attach: "هتل رستوران نفت" },
  ];
  const userIds = {};
  for (const u of USERS) {
    let user = await prisma.user.findUnique({ where: { phone: u.phone }, select: { id: true, passwordSet: true } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          phone: u.phone,
          name: `${u.firstName} ${u.lastName}`,
          firstName: u.firstName,
          lastName: u.lastName,
          passwordHash: pwHash,
          passwordSet: true,
          country: "IR",
          language: "fa",
        },
        select: { id: true, passwordSet: true },
      });
      log(`+ کاربر جدید ${u.phone} (${u.firstName} ${u.lastName})`);
    } else if (!user.passwordSet || user.passwordSet === undefined) {
      await prisma.user.update({ where: { id: user.id }, data: { passwordSet: true } });
      log(`~ passwordSet=true برای ${u.phone}`);
    }
    // رمز همه = 123456 (خواسته‌ی صریح کاربر)
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: pwHash, passwordSet: true } });
    userIds[u.phone] = user.id;
  }
  log(`رمز ${PASSWORD} برای هر ${USERS.length} کاربر ست شد`);

  /* ═══ ۳) بیزینس‌های جدید + اتصال مالک‌ها ═══ */
  console.log("\n[3] کسب‌وکارها");

  async function ensureBiz(spec) {
    let biz = await prisma.business.findFirst({ where: { name: spec.name }, select: { id: true, slug: true } });
    if (!biz) {
      biz = await prisma.business.create({
        data: {
          slug: spec.slug, name: spec.name, city: spec.city, province: spec.province,
          country: "IR", currency: "IRR", trade: spec.trade, phone: spec.phone ?? null,
          ownerId: spec.ownerId ?? null, isDemo: spec.isDemo ?? true, isVerified: spec.isVerified ?? false,
          enabledArms: spec.enabledArms ?? null,
        },
        select: { id: true, slug: true },
      });
      for (const type of ["SELL", "BUY"]) await prisma.page.create({ data: { businessId: biz.id, type } });
      log(`+ بیزینس «${spec.name}» (${spec.city})`);
    } else {
      // ترمیم: مالک/صنف/بازوها/شهر همیشه درست باشند
      await prisma.business.update({
        where: { id: biz.id },
        data: {
          ...(spec.ownerId ? { ownerId: spec.ownerId } : {}),
          ...(spec.trade ? { trade: spec.trade } : {}),
          ...(spec.city && spec.province ? { city: spec.city, province: spec.province } : {}),
          ...(spec.enabledArms !== undefined ? { enabledArms: spec.enabledArms } : {}),
          ...(spec.phone ? { phone: spec.phone } : {}),
        },
      });
      log(`= بیزینس «${spec.name}» موجود — ترمیم شد`);
    }
    return biz;
  }

  // کشاورز ۱ — مزرعه برنج (فروش حداقل ۱۰ تن = ۲۰۰ کیسه‌ی ۵۰کیلویی)
  const farm = await ensureBiz({
    name: "مزرعه برنج سراوان", slug: "farm-saravan", city: "فومن", province: "گیلان",
    trade: "شالی‌کاری", phone: "01344556677", ownerId: userIds["989111111111"], isDemo: false,
  });
  // بنکدار بزرگ برنج — عمده‌فروش سطح بالا (۲۰ تن+، انبار ۶۰۰ تن)
  const bankdar = await ensureBiz({
    name: "بنکداری برنج گیل", slug: "bankdar-gil-rice", city: "رشت", province: "گیلان",
    trade: "بنکداری برنج", phone: "01334455667", ownerId: userIds["989222222222"], isDemo: false,
  });
  // تالار ۱ (با کاربر — فقط دستیار خرید)
  const talarNiayesh = await ensureBiz({
    name: "تالار مجلل نیایش", slug: "talar-niayesh", city: "رشت", province: "گیلان",
    trade: "تالار پذیرایی", phone: "01335566778", ownerId: userIds["989444444444"], isDemo: false,
    enabledArms: { sell: false, buy: true }, // چیزی برای فروش عمده ندارد — سوییچر غیب
  });
  // تالار ۲ (بدون کاربر — برای شبکه‌ی دمو)
  const talarGolestan = await ensureBiz({
    name: "تالار گلستان رشت", slug: "talar-golestan", city: "رشت", province: "گیلان",
    trade: "تالار", phone: "01336677889", enabledArms: { sell: false, buy: true },
  });
  // هتل — فقط دستیار خرید
  const hotel = await ensureBiz({
    name: "هتل رستوران نفت", slug: "hotel-naft", city: "بندر انزلی", province: "گیلان",
    trade: "هتل", phone: "01445566778", ownerId: userIds["989555555555"],
    enabledArms: { sell: false, buy: true },
  });
  // رستوران — هر دو بازو (کاتالوک غذای گرم + لیست خرید)
  const divan = await ensureBiz({
    name: "رستوران دیوان", slug: "d-divan-01", city: "رشت", province: "گیلان",
    trade: "رستوران", phone: "01333445566", ownerId: userIds["989333333333"],
  });
  // پارس — تامین‌کننده‌ی اصلی دمو
  const pars = await prisma.business.findFirst({
    where: { owner: { phone: "989196421264" } },
    select: { id: true, slug: true, name: true },
  });
  await prisma.business.update({ where: { id: pars.id }, data: { trade: "پخش برنج" } });

  const otherSuppliers = {};
  for (const nm of ["پخش مواد غذایی انزلی", "تجارت گیل‌رنج", "کیان غلات", "پخش نگین", "پخش پارس‌غذا", "پخت‌وپز صنعت گیل"]) {
    otherSuppliers[nm] = await prisma.business.findFirst({ where: { name: nm }, select: { id: true, slug: true } });
    if (!otherSuppliers[nm]) throw new Error(`business not found: ${nm}`);
  }
  await prisma.business.update({ where: { id: otherSuppliers["پخش مواد غذایی انزلی"].id }, data: { trade: "پخش برنج" } });
  await prisma.business.update({ where: { id: otherSuppliers["تجارت گیل‌رنج"].id }, data: { trade: "پخش برنج" } });
  await prisma.business.update({ where: { id: otherSuppliers["کیان غلات"].id }, data: { trade: "پخش برنج" } });
  await prisma.business.update({ where: { id: otherSuppliers["پخش نگین"].id }, data: { trade: "پخش برنج" } });
  log("~ صنف پخش‌های برنج به «پخش برنج» ست شد");

  /* ═══ ۴) کاتالوگ غذای گرم — دسته + کالا + آگهی رستوران دیوان ═══ */
  console.log("\n[4] غذای گرم رستوران (چلوکباب/چلومرغ)");
  let hotCat = await prisma.category.findFirst({ where: { slug: "hot-food" }, select: { id: true } });
  if (!hotCat) {
    hotCat = await prisma.category.create({
      data: {
        slug: "hot-food", nameFa: "غذای گرم", nameEn: "Hot food", parentId: FOOD_CAT,
      },
      select: { id: true },
    });
    log("+ دسته «غذای گرم» زیر «مواد غذایی و آشامیدنی»");
  }
  async function ensureGood(nameFa, nameEn, unit, aliases) {
    let g = await prisma.good.findFirst({ where: { nameFa }, select: { id: true } });
    if (!g) {
      g = await prisma.good.create({
        data: {
          categoryId: hotCat.id, nameFa, nameEn, aliases, unit,
          searchText: `${nameFa} ${nameEn} ${aliases.join(" ")}`,
          source: "SEED", status: "ACTIVE", creatorRole: "ADMIN",
        },
        select: { id: true },
      });
      log(`+ کالای مرجع «${nameFa}»`);
    }
    return g;
  }
  const kebab = await ensureGood("چلوکباب", "Chelo-kebab", "SERVICE", ["چلو کباب", "کباب کوبیده", "chelo kebab"]);
  const morgh = await ensureGood("چلومرغ", "Chelo-morgh", "SERVICE", ["چلو مرغ", "chelo morgh"]);

  /* ═══ ۵) لیستینگ‌ها — ensure/repair با اعداد واقع‌بینانه ═══ */
  console.log("\n[5] آگهی‌ها");
  // پاک‌سازی ردیف‌های اجرای ناقص قبلی (کلید یکتا: business+good+variantKey)
  for (const nm of ["مزرعه برنج سراوان", "بنکداری برنج گیل"]) {
    const b = await prisma.business.findFirst({ where: { name: nm }, select: { id: true } });
    const bad = await prisma.listing.findMany({ where: { businessId: b.id, variantKey: "" }, select: { id: true } });
    if (bad.length) {
      await prisma.listing.deleteMany({ where: { id: { in: bad.map((x) => x.id) } } });
      log(`~ ${bad.length} آگهی بدون variantKey «${nm}» پاک شد (اجراهای ناقص)`);
    }
  }
  /**
   * نکته‌ی ساختاری: Listing یکتاست روی (business, good, variantKey) — نه mode.
   * BUY همیشه variantKey="need" دارد؛ SELL برنج کلید صفات («packaging=sack|…»).
   * در ensureListing برای BUY اول هر آگهی خریدِ همان کالا را پیدا می‌کنیم (هر کلیدی)
   * تا برای بیزینس‌های قدیمی (هتل) ردیف دوم ساخته نشود.
   */
  async function ensureListing(bizId, spec) {
    let found = spec.mode === "BUY"
      ? await prisma.listing.findFirst({
          where: { businessId: bizId, goodId: spec.goodId, mode: { in: ["BUY", "BOTH"] } },
          select: { id: true, priceMinor: true, stock: true, minOrder: true, volume: true, frequency: true, isActive: true, variantKey: true },
        })
      : await prisma.listing.findFirst({
          where: { businessId: bizId, goodId: spec.goodId, mode: { in: ["SELL", "BOTH"] }, variantKey: spec.variantKey ?? "" },
          select: { id: true, priceMinor: true, stock: true, minOrder: true, volume: true, frequency: true, isActive: true, variantKey: true },
        });
    if (!found) {
      const l = await prisma.listing.create({
        data: {
          businessId: bizId, goodId: spec.goodId, mode: spec.mode,
          variantKey: spec.mode === "BUY" ? "need" : (spec.variantKey ?? ""),
          variantLabel: spec.variantLabel ?? null,
          priceMinor: spec.priceMinor ?? null, currency: "IRR",
          stock: spec.stock ?? null, minOrder: spec.minOrder ?? null,
          volume: spec.volume ?? null, frequency: spec.frequency ?? null,
          city: spec.city ?? null, province: spec.province ?? null, isActive: true,
        },
      });
      log(`+ ${spec.label}`);
      return l;
    }
    const drift =
      (spec.priceMinor !== undefined && found.priceMinor !== spec.priceMinor) ||
      (spec.stock !== undefined && found.stock !== spec.stock) ||
      (spec.minOrder !== undefined && found.minOrder !== spec.minOrder) ||
      (spec.volume !== undefined && found.volume !== spec.volume) ||
      (spec.frequency !== undefined && (found.frequency ?? null) !== (spec.frequency ?? null)) ||
      found.isActive === false;
    if (drift) {
      await prisma.listing.update({
        where: { id: found.id },
        data: {
          ...(spec.priceMinor !== undefined ? { priceMinor: spec.priceMinor } : {}),
          ...(spec.stock !== undefined ? { stock: spec.stock } : {}),
          ...(spec.minOrder !== undefined ? { minOrder: spec.minOrder } : {}),
          ...(spec.volume !== undefined ? { volume: spec.volume } : {}),
          ...(spec.frequency !== undefined ? { frequency: spec.frequency } : {}),
          ...(spec.variantLabel ? { variantLabel: spec.variantLabel } : {}),
          ...(spec.city ? { city: spec.city, province: spec.province } : {}),
          ...(spec.mode === "BUY" ? { variantKey: "need" } : {}),
          isActive: true,
        },
      });
      log(`~ ترمیم ${spec.label}`);
    } else log(`= ${spec.label}`);
    return found;
  }

  // — مزرعه: فروش در مقیاس کشاورز (حداقل ۱۰ تن = ۲۰۰ کیسه‌ی ۵۰کیلویی) —
  const SACK50 = "packaging=sack|variety=grade1|weight=50kg";
  const SACK50G2 = "packaging=sack|variety=grade2|weight=50kg";
  await ensureListing(farm.id, { goodId: RICE_HASHEMI, mode: "SELL", variantKey: SACK50, variantLabel: "کیسه · درجه یک · ۵۰ کیلوگرمی", label: "مزرعه: فروش هاشمی ۲۷.۵M (حداقل ۲۰۰ کیسه=۱۰ تن)", priceMinor: 27_500_000, stock: 4000, minOrder: 200, city: "فومن", province: "گیلان" });
  await ensureListing(farm.id, { goodId: RICE_TAROM, mode: "SELL", variantKey: SACK50, variantLabel: "کیسه · درجه یک · ۵۰ کیلوگرمی", label: "مزرعه: فروش طارم ۲۴.۵M", priceMinor: 24_500_000, stock: 2500, minOrder: 200, city: "فومن", province: "گیلان" });
  // کشاورز فقط در مقیاس کوچک می‌خرد (بذر فصلی) — در تقابل با خرید سنگین پخش‌ها
  await ensureListing(farm.id, { goodId: SEED_RICE, mode: "BUY", variantLabel: "کیلوگرم", label: "مزرعه: خرید بذر برنج ۵۰۰ کیلو/فصلی", volume: 500, frequency: "OCCASIONAL", city: "فومن", province: "گیلان" });

  // — بنکدار: عمده‌فروش سطح بالا —
  await ensureListing(bankdar.id, { goodId: RICE_HASHEMI, mode: "SELL", variantKey: SACK50, variantLabel: "کیسه · درجه یک · ۵۰ کیلوگرمی", label: "بنکدار: فروش هاشمی ۲۶.۸M (حداقل ۴۰۰ کیسه=۲۰ تن)", priceMinor: 26_800_000, stock: 12000, minOrder: 400, city: "رشت", province: "گیلان" });
  await ensureListing(bankdar.id, { goodId: RICE_FAJR, mode: "SELL", variantKey: SACK50G2, variantLabel: "کیسه · درجه دو · ۵۰ کیلوگرمی", label: "بنکدار: فروش فجر ۲۴.۲M", priceMinor: 24_200_000, stock: 8000, minOrder: 400, city: "رشت", province: "گیلان" });
  await ensureListing(bankdar.id, { goodId: RICE_HASHEMI, mode: "BUY", variantLabel: "کیسه ۵۰ کیلویی", label: "بنکدار: خرید هاشمی ۲۰۰۰ کیسه/ماه (۱۰۰ تن)", volume: 2000, frequency: "MONTHLY", city: "رشت", province: "گیلان" });

  // — تامین‌کننده‌های برنج: خودشان هم در سطح بالا می‌خرند (خواسته‌ی کاربر) —
  await ensureListing(otherSuppliers["پخش مواد غذایی انزلی"].id, { goodId: RICE_HASHEMI, mode: "BUY", variantLabel: "کیسه ۵۰ کیلویی", label: "انزلی: خرید هاشمی ۶۰۰ کیسه/ماه (۳۰ تن)", volume: 600, frequency: "MONTHLY", city: "رشت", province: "گیلان" });
  await ensureListing(otherSuppliers["تجارت گیل‌رنج"].id, { goodId: RICE_HASHEMI, mode: "BUY", variantLabel: "کیسه ۵۰ کیلویی", label: "گیل‌رنج: خرید هاشمی ۸۰۰ کیسه/ماه (۴۰ تن)", volume: 800, frequency: "MONTHLY", city: "رشت", province: "گیلان" });
  await ensureListing(otherSuppliers["کیان غلات"].id, { goodId: RICE_HASHEMI, mode: "BUY", variantLabel: "کیسه ۵۰ کیلویی", label: "کیان: خرید هاشمی ۵۰۰ کیسه/ماه (۲۵ تن)", volume: 500, frequency: "MONTHLY", city: "قزوین", province: "قزوین" });
  await ensureListing(otherSuppliers["پخش نگین"].id, { goodId: RICE_HASHEMI, mode: "BUY", variantLabel: "کیسه ۵۰ کیلویی", label: "نگین: خرید هاشمی ۳۰۰ کیسه/ماه (۱۵ تن)", volume: 300, frequency: "MONTHLY", city: "قزوین", province: "قزوین" });

  // — پارس (دمو): خرید در سطح پخش (خیلی بالاتر از کشاورز) —
  await ensureListing(pars.id, { goodId: RICE_HASHEMI, mode: "BUY", label: "پارس: خرید هاشمی ۱۰۰۰ کیسه/ماه (۵۰ تن)", volume: 1000, frequency: "MONTHLY" });

  // — تأمین‌کننده‌های روغن/رب (جانشین سوپرمارکت‌ها) —
  await ensureListing(otherSuppliers["پخش پارس‌غذا"].id, { goodId: OIL, mode: "SELL", variantKey: "packaging=carton|count=12", variantLabel: "جعبه ۱۲ عددی", label: "پارس‌غذا: فروش روغن ۵.۱M", priceMinor: 5_100_000, stock: 5000, minOrder: 20, city: "تهران", province: "تهران" });
  await ensureListing(otherSuppliers["پخت‌وپز صنعت گیل"].id, { goodId: OIL, mode: "SELL", variantKey: "packaging=carton|count=12", variantLabel: "جعبه ۱۲ عددی", label: "پخت‌وپز: فروش روغن ۵.۳M", priceMinor: 5_300_000, stock: 2000, minOrder: 10, city: "رشت", province: "گیلان" });
  await ensureListing(otherSuppliers["پخت‌وپز صنعت گیل"].id, { goodId: PASTE, mode: "SELL", variantKey: "packaging=carton|weight=500g", variantLabel: "کارتن ۲۴ عددی", label: "پخت‌وپز: فروش رب ۲.۸۵M", priceMinor: 2_850_000, stock: 1500, minOrder: 10, city: "رشت", province: "گیلان" });

  // — خریداران عمده: رستوران/تالار/هتل —
  await ensureListing(divan.id, { goodId: RICE_HASHEMI, mode: "BUY", variantLabel: "کیسه ۵۰ کیلویی", label: "دیوان: خرید هاشمی ۳۰ کیسه/ماه", volume: 30, frequency: "MONTHLY", city: "رشت", province: "گیلان" });
  // کاتالوگ غذای گرم رستوران (خواسته‌ی کاربر)
  await ensureListing(divan.id, { goodId: kebab.id, mode: "SELL", variantKey: "portion=full", variantLabel: "پرس کامل", label: "دیوان: چلوکباب ۹۸۰ هزار تومان/پرس", priceMinor: 9_800_000, minOrder: 5, stock: 200, city: "رشت", province: "گیلان" });
  await ensureListing(divan.id, { goodId: morgh.id, mode: "SELL", variantKey: "portion=full", variantLabel: "پرس کامل", label: "دیوان: چلومرغ ۱.۱۵M/پرس", priceMinor: 11_500_000, minOrder: 5, stock: 150, city: "رشت", province: "گیلان" });
  await ensureListing(talarNiayesh.id, { goodId: RICE_HASHEMI, mode: "BUY", variantLabel: "کیسه ۵۰ کیلویی", label: "نیایش: خرید هاشمی ۸۰ کیسه/ماه", volume: 80, frequency: "MONTHLY", city: "رشت", province: "گیلان" });
  await ensureListing(talarGolestan.id, { goodId: RICE_TAROM, mode: "BUY", variantLabel: "کیسه ۵۰ کیلویی", label: "گلستان: خرید طارم ۶۰ کیسه/ماه", volume: 60, frequency: "MONTHLY", city: "رشت", province: "گیلان" });
  await ensureListing(hotel.id, { goodId: RICE_FAJR, mode: "BUY", variantLabel: "کیسه ۵۰ کیلویی", label: "هتل نفت: خرید فجر ۱۲۰ کیسه/ماه", volume: 120, frequency: "MONTHLY", city: "بندر انزلی", province: "گیلان" });

  // هتل/تالار نباید آگهی فروش داشته باشند (چیزی برای فروش عمده ندارند)
  for (const [bid, nm] of [[hotel.id, "هتل"], [talarNiayesh.id, "تالار نیایش"], [talarGolestan.id, "تالار گلستان"]]) {
    const sells = await prisma.listing.findMany({ where: { businessId: bid, mode: { in: ["SELL", "BOTH"] } }, select: { id: true } });
    if (sells.length) {
      await prisma.listing.deleteMany({ where: { id: { in: sells.map((s) => s.id) } } });
      log(`~ ${sells.length} آگهی فروشِ اضافی ${nm} حذف شد`);
    }
  }

  /* ═══ ۶) فالوها — شبکه‌ی تأمین/مشتری ═══ */
  console.log("\n[6] فالوها");
  async function ensureFollow(followerBizId, supplierBizId) {
    const fp = await prisma.page.findFirst({ where: { businessId: followerBizId, type: "BUY" }, select: { id: true } });
    const sp = await prisma.page.findFirst({ where: { businessId: supplierBizId, type: "SELL" }, select: { id: true } });
    const found = await prisma.follow.findFirst({ where: { followerPageId: fp.id, supplierPageId: sp.id }, select: { id: true } });
    if (!found) {
      await prisma.follow.create({ data: { followerPageId: fp.id, supplierPageId: sp.id, createdAt: iso(3 * DAY) } });
      log("+ فالو (خریدار→تأمین‌کننده)");
    }
  }
  // خریداران → پارس (مشتری‌های پخش برنج)
  for (const b of [divan, talarNiayesh, talarGolestan, hotel]) await ensureFollow(b.id, pars.id);
  // پارس → تأمین‌کننده‌های برنجش (مزرعه/بنکدار/انزلی/گیل‌رنج/کیان/نگین/پارس‌غذا/پخت‌وپز)
  await ensureFollow(pars.id, farm.id);
  await ensureFollow(pars.id, bankdar.id);
  await ensureFollow(pars.id, otherSuppliers["پخش پارس‌غذا"].id);
  await ensureFollow(pars.id, otherSuppliers["پخت‌وپز صنعت گیل"].id);
  // بنکدار هم از مزرعه می‌خرد
  await ensureFollow(bankdar.id, farm.id);

  /* ═══ ۷) دنبال‌کردن کالا (لیست خرید خریداران) ═══ */
  console.log("\n[7] لیست خرید");
  async function ensureWatch(bizId, goodId) {
    const found = await prisma.watchedGood.findFirst({ where: { businessId: bizId, goodId }, select: { id: true } });
    if (!found) {
      await prisma.watchedGood.create({ data: { businessId: bizId, goodId, createdAt: iso(2 * DAY) } });
      log("+ واچ");
    }
  }
  await ensureWatch(divan.id, RICE_HASHEMI);
  await ensureWatch(talarNiayesh.id, RICE_HASHEMI);
  await ensureWatch(talarGolestan.id, RICE_TAROM);
  await ensureWatch(bankdar.id, RICE_HASHEMI);
  await ensureWatch(farm.id, RICE_HASHEMI); // کشاورز هم قیمت بازار را دنبال می‌کند

  /* ═══ ۸) استعلام‌ها و پیشنهادها — جانشین‌های سوپرمارکت‌ها ═══ */
  console.log("\n[8] استعلام‌ها");
  async function ensureInquiry(spec) {
    const { label, ...data } = spec;
    const found = await prisma.inquiry.findFirst({
      where: { sellerId: spec.sellerId, buyerId: spec.buyerId, listingId: spec.listingId, volume: spec.volume },
      select: { id: true, status: true },
    });
    if (!found) {
      await prisma.inquiry.create({ data: { ...data, createdAt: spec.createdAt ?? iso(2 * DAY) } });
      log(`+ استعلام ${label}`);
    } else if (found.status !== spec.status) {
      await prisma.inquiry.update({ where: { id: found.id }, data: { status: spec.status } });
      log(`~ ترمیم استعلام ${label}`);
    }
  }
  async function ensureOffer(spec) {
    const { label, ...data } = spec;
    const found = await prisma.offer.findFirst({
      where: { sellerId: spec.sellerId, buyerId: spec.buyerId, listingId: spec.listingId },
      select: { id: true },
    });
    if (!found) {
      await prisma.offer.create({ data });
      log(`+ پیشنهاد ${label}`);
    }
  }
  // استعلام/پیشنهاد همیشه به آگهیِ فروشِ فروشنده اشاره می‌کند (نه خریدِ او)
  const parsSellListings = await prisma.listing.findMany({
    where: { businessId: pars.id, mode: "SELL" },
    select: { id: true, goodId: true, variantLabel: true },
  });
  const parsHashemi50 = parsSellListings.find((l) => l.goodId === RICE_HASHEMI && (l.variantLabel ?? "").includes("۵۰"));
  const parsFajr50 = parsSellListings.find((l) => l.goodId === RICE_FAJR && (l.variantLabel ?? "").includes("۵۰"));
  // پاک‌سازی استعلام‌هایی که اشتباهاً به آگهی خرید پارس اشاره کردند
  const parsBuyIds = (await prisma.listing.findMany({ where: { businessId: pars.id, mode: "BUY" }, select: { id: true } })).map((l) => l.id);
  const badInq = await prisma.inquiry.findMany({ where: { listingId: { in: parsBuyIds } }, select: { id: true } });
  if (badInq.length) {
    await prisma.inquiry.deleteMany({ where: { id: { in: badInq.map((x) => x.id) } } });
    log(`~ ${badInq.length} استعلام با listing اشتباه پاک شد`);
  }
  if (!parsHashemi50 || !parsFajr50) throw new Error("pars SELL listings not found");

  // incoming (درخواست‌های قیمتِ پارس — صفحه فروش)
  await ensureInquiry({ sellerId: pars.id, buyerId: talarNiayesh.id, listingId: parsHashemi50.id, volume: 80, frequency: "MONTHLY", delivery: "این ماه", note: "برای پذیرایی ماه محرم، برنج هاشمی بوجار درجه یک لازم داریم. امکان تحویل مرحله‌ای در طول ماه دارید؟", status: "ANSWERED", isRead: true, label: "نیایش→پارس هاشمی (پاسخ داده شد)" });
  await ensureInquiry({ sellerId: pars.id, buyerId: hotel.id, listingId: parsFajr50.id, volume: 120, frequency: "MONTHLY", delivery: "فوری", note: null, status: "NEW", isRead: false, label: "هتل نفت→پارس فجر" });
  await ensureOffer({ sellerId: pars.id, buyerId: talarNiayesh.id, listingId: parsHashemi50.id, priceMinor: 28_100_000, currency: "IRR", minOrder: 200, score: 92, isSpecial: true, note: "تحویل مرحله‌ای هر ۱۰ روز، حمل با ما.", label: "پارس→نیایش ۲۸.۱M" });

  // outgoing (درخواست‌های منِ پارس — جانشین سعید/سپید)
  const parsneginTarom = await prisma.listing.findFirst({ where: { businessId: otherSuppliers["پخش نگین"].id, goodId: RICE_TAROM, mode: { in: ["SELL", "BOTH"] } }, select: { id: true } });
  const parsfoodOil = await prisma.listing.findFirst({ where: { businessId: otherSuppliers["پخش پارس‌غذا"].id, goodId: OIL, mode: { in: ["SELL", "BOTH"] } }, select: { id: true } });
  const cookPaste = await prisma.listing.findFirst({ where: { businessId: otherSuppliers["پخت‌وپز صنعت گیل"].id, goodId: PASTE, mode: { in: ["SELL", "BOTH"] } }, select: { id: true } });
  const anzaliHashemi = await prisma.listing.findFirst({ where: { businessId: otherSuppliers["پخش مواد غذایی انزلی"].id, goodId: RICE_HASHEMI, mode: { in: ["SELL", "BOTH"] } }, select: { id: true } });
  if (parsneginTarom) {
    await ensureInquiry({ sellerId: otherSuppliers["پخش نگین"].id, buyerId: pars.id, listingId: parsneginTarom.id, volume: 300, frequency: "MONTHLY", note: null, status: "ANSWERED", isRead: true, createdAt: iso(2 * DAY), label: "پارس→نگین طارم" });
    await ensureOffer({ sellerId: otherSuppliers["پخش نگین"].id, buyerId: pars.id, listingId: parsneginTarom.id, priceMinor: 29_200_000, currency: "IRR", minOrder: 100, score: 88, note: null, label: "نگین→پارس ۲۹.۲M" });
  }
  if (parsfoodOil) {
    await ensureInquiry({ sellerId: otherSuppliers["پخش پارس‌غذا"].id, buyerId: pars.id, listingId: parsfoodOil.id, volume: 200, frequency: "MONTHLY", delivery: "این ماه", note: "روغن مخصوص رستوران‌های همکار — ۲۰۰ جعبه ماهانه.", status: "ANSWERED", isRead: true, label: "پارس→پارس‌غذا روغن" });
    await ensureOffer({ sellerId: otherSuppliers["پخش پارس‌غذا"].id, buyerId: pars.id, listingId: parsfoodOil.id, priceMinor: 5_050_000, currency: "IRR", minOrder: 50, score: 85, note: "برای پخش‌ها ۵٪ تخفیف پلکانی.", label: "پارس‌غذا→پارس ۵.۰۵M" });
  }
  if (cookPaste) {
    await ensureInquiry({ sellerId: otherSuppliers["پخت‌وپز صنعت گیل"].id, buyerId: pars.id, listingId: cookPaste.id, volume: 60, frequency: "WEEKLY", note: null, status: "NEW", isRead: false, label: "پارس→پخت‌وپز رب" });
  }
  if (anzaliHashemi) {
    await ensureInquiry({ sellerId: otherSuppliers["پخش مواد غذایی انزلی"].id, buyerId: pars.id, listingId: anzaliHashemi.id, volume: 600, frequency: "MONTHLY", note: "برنج هاشمی بهبوجار، تحویل انبار رشت.", status: "NEW", isRead: false, label: "پارس→انزلی هاشمی" });
  }

  /* ═══ ۹) روند قیمت‌ها — جانشین سوپرمارکت سعید (روغن ▲۵٪) ═══ */
  console.log("\n[9] روند قیمت");
  if (parsfoodOil) {
    const logCount = await prisma.priceLog.count({ where: { listingId: parsfoodOil.id } });
    if (logCount === 0) {
      await prisma.priceLog.create({ data: { listingId: parsfoodOil.id, oldMinor: 4_860_000, newMinor: 5_100_000, createdAt: iso(3 * DAY) } });
      log("+ روند روغن پارس‌غذا ▲۴.۹٪");
    }
  }

  /* ═══ ۱۰) اعلان‌های تازه برای کاربر دمو ═══ */
  console.log("\n[10] اعلان‌ها");
  const parsUserId = userIds["989196421264"];
  const QUOTES = [
    { actorId: talarNiayesh.id, actorName: "تالار مجلل نیایش", actorSlug: talarNiayesh.slug, good: "برنج هاشمی" },
    { actorId: hotel.id, actorName: "هتل رستوران نفت", actorSlug: hotel.slug, good: "برنج فجر" },
  ];
  for (const q of QUOTES) {
    const found = await prisma.notification.findFirst({
      where: { userId: parsUserId, type: "QUOTE", actorId: q.actorId },
      select: { id: true },
    });
    if (!found) {
      await prisma.notification.create({ data: { userId: parsUserId, type: "QUOTE", ...q, read: false, createdAt: iso(1 * DAY) } });
      log(`+ اعلان QUOTE از ${q.actorName}`);
    }
  }

  /* ═══ ۱۱) گزارش نهایی ═══ */
  console.log("\n═══ وضعیت نهایی ═══");
  const finalBizs = await prisma.business.findMany({
    select: { name: true, trade: true, city: true, enabledArms: true, owner: { select: { phone: true } }, _count: { select: { listings: true } } },
    orderBy: { createdAt: "asc" },
  });
  for (const b of finalBizs)
    console.log(
      `${b.name} | ${b.trade ?? "-"} | ${b.city} | arms=${JSON.stringify(b.enabledArms ?? "both")} | ${b.owner?.phone ?? "بدون کاربر"} | ${b._count.listings} آگهی`
    );
  console.log(`جمع: ${finalBizs.length} کسب‌وکار`);
}

main()
  .catch((e) => { console.error("SEED FAILED:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
