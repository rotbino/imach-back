import { Prisma } from "@prisma/client";

/**
 * M11 §۹ (دیوباری‌ها): دو نسخهٔ موازی LISTING_SELECT در
 * listings.controller و businesses.controller به یک ماژول یگانه آمد.
 *
 * ▸ LISTING_SELECT        — نمای کاملِ فروشنده؛ همان شکل ردیف‌های
 *   getMyListings. هر مسیر ذخیره همین را برمی‌گرداند تا کش کلاینت
 *   هرگز با ردیفِ نیم‌ساخت روبه‌رو نشود.
 *
 * ▸ PUBLIC_LISTING_SELECT — نمای عمومی کاتالوگ/ویترین؛ زیرمجموعهٔ
 *   نمای فروشنده. فیلدهای داخلی (variantKey · productId · isActive)
 *   عمداً حذف شده‌اند تا به پاسخ‌های عمومی نریزند.
 */
export const LISTING_SELECT = {
  id: true,
  mode: true,
  variantKey: true,
  variantLabel: true,
  productId: true,
  priceMinor: true,
  currency: true,
  attrs: true,
  stock: true,
  minOrder: true,
  volume: true,
  frequency: true,
  updatedAt: true,
  // M2 — متن شخصی ردیف + مهر قیمت‌گذاری (بج «منقضی») + قرارداد واحد-قیمت
  baseQty: true,
  pricePerBaseMinor: true,
  // مدل واحد (۱۰۲۶) — بستهٔ انتخابی: [{label, qty}]
  packaging: true,
  title: true,
  note: true,
  pricedAt: true,
  // FD-9 — اعتبار قیمت همین ردیف (null = همان تنظیم کاتالوک)
  priceValidDays: true,
  // ── وضعیت + شاخص‌های مالک (فاز ۲) — ردیف غیرفعال و شمارش بازدید
  isActive: true,
  viewCount30: true,
  viewCountTotal: true,
  // ── فاز ۳ — دستهٔ شخصی کاتالوگ برای چيپ‌های ویترین
  catalogCategoryId: true,
  brand: { select: { id: true, name: true } },
  good: {
    select: {
      id: true,
      nameFa: true,
      nameEn: true,
      unit: true,
      category: { select: { slug: true, nameFa: true, nameEn: true } },
    },
  },
  // ── عکس مرجع محصول — وقتی آگهی گالری ندارد، این عکس نشان داده می‌شود
  // (کاتالوگ فروش خالی از عکس، با عکس مرجع محصول پر می‌شود)
  product: { select: { imageUrl: true } },
} as const satisfies Prisma.ListingSelect;

export const PUBLIC_LISTING_SELECT = {
  id: true,
  mode: true,
  // فاز ۲ — صفحهٔ جزئیات کالای عمومی (طرح ۰۲) به واریانت و عکس مرجع نیاز دارد
  variantLabel: true,
  // فاز ۳ — دستهٔ شخصی کاتالوگ برای چيپ‌های ویترین عمومی
  catalogCategoryId: true,
  priceMinor: true,
  currency: true,
  attrs: true,
  stock: true,
  minOrder: true,
  volume: true,
  frequency: true,
  // فاز ۷ مهاجرت — کاتالوگ/کالای عمومی: «آخرین به‌روزرسانی» + بازدید پنجرهٔ ۳۰روزه
  updatedAt: true,
  viewCount30: true,
  viewCountTotal: true,
  // M2 — متن شخصی ردیف + مهر قیمت‌گذاری (بج «منقضی» عمومی از آن ساخته می‌شود)
  title: true,
  note: true,
  pricedAt: true,
  // FD-9 — اعتبار قیمتِ خودِ ردیف (بر تنظیم کاتالوگ اولویت دارد)
  priceValidDays: true,
  baseQty: true,
  pricePerBaseMinor: true,
  // مدل واحد (۱۰۲۶) — بستهٔ انتخابی ردیف: [{label, qty}] برای کارت‌های عمومی
  packaging: true,
  brand: { select: { id: true, name: true } },
  good: {
    select: {
      id: true,
      nameFa: true,
      nameEn: true,
      unit: true,
      category: { select: { slug: true, nameFa: true, nameEn: true } },
    },
  },
  product: { select: { imageUrl: true } },
} as const satisfies Prisma.ListingSelect;
