import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, Matches, MaxLength, Max, Min, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { BuySpecDto, SellSpecDto, TRADE_MODES } from "../../goods/dto/goods.dto";

/**
 * PUT /listings/saveListing — upsert one listing per (business, good).
 * Spec consistency (SELL needs sell spec, BUY needs buy spec) is enforced
 * in the service because it depends on the mode value.
 * Currency is NOT taken from the client — it is inherited from the business
 * (which got it from the owner's signup country), so the catalog keeps ONE
 * coherent unit per arm. priceMinor is always the smallest currency unit.
 */
export class SaveListingDto {
  @IsString()
  businessId: string;

  @IsString()
  goodId: string;

  @IsString()
  @IsIn(TRADE_MODES)
  mode: string;

  /** optional brand — free text, resolved/created server-side by normalized name */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  brandName?: string;

  /** shared SKU (the picker's pick) — validated server-side against goodId;
   * omitted → identity is derived silently from brandName+attrs */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  productId?: string;

  /** the exact row being edited — when present the save UPDATES this row in
   * place (id, gallery and price history survive) instead of upserting by
   * identity key. Without it, a legacy row would fork into an imageless twin. */
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-fA-F]{24}$/)
  listingId?: string;

  /** category attribute values (weight, packaging …) — shallow string map */
  @IsOptional()
  @IsObject()
  attrs?: Record<string, string>;

  /** human-friendly product label — user can type a custom display name.
   *  If omitted, the system auto-generates one from goodName + brand + attrs.
   *  The machine identity (searchText) is ALWAYS auto-derived from brand +
   *  attrs — this label is only for display and search.
   *  ⚠ M2 (C6): این فیلد دیگر Product.label مرجع را بازنویسی نمی‌کند —
   *  عنوان شخصی حالا در Listing.title ذخیره می‌شود و این فیلد فقط برای
   *  سازگاری کلاینت‌های قدیمی پذیرفته می‌شود (نادیده گرفته نمی‌شود ولی
   *  روی محصول مشترک اثری ندارد). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  productLabel?: string;

  // ── M2 مهاجرت (سند ۰۶ §۳) — فیلدهای v2 ──
  /** C6 — عنوان شخصی این ردیف در ویترین من («برنج هاشمی درجه یک»).
   *  null صریح = پاک‌کردن؛ undefined = بدون تغییر. نام مرجع Good دست‌نخورده. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string | null;

  /** C2 — توضیح کوتاه فروشنده زیر ردیف («تحویل از انبار تهران»). */
  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string | null;

  /** C5 — تعداد واحد پایه در این ردیف («کیسهٔ ۵۰ کیلویی» → 50).
   *  سرور pricePerBaseMinor = priceMinor ÷ baseQty را می‌سازد.
   *  undefined = بدون تغییر؛ null/۰ صریح = فله (بدون بسته — قیمتِ خودِ واحد
   *  مصرف‌کننده؛ pricePerBaseMinor = priceMinor). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1e9)
  baseQty?: number | null;

  /** مدل واحد (حکم مالک ۱۰۲۶) — نام بستهٔ انتخابی این ردیف («کیسهٔ ۵۰ کیلویی»
   *  / «کارتن ۶۰ عددی» / «گونی ۷۰ کیلویی»). با baseQty در Listing.packaging
   *  ذخیره می‌شود تا کارت‌ها و ویرایش همان را نشان بدهند.
   *  null صریح = فله/بدون بسته؛ undefined = بدون تغییر. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  packLabel?: string | null;

  /** FD-9 — یادآوری آپدیت قیمتِ همین ردیف (۱..۵ روز؛ فرم پیش‌فرض ۳ می‌فرستد).
   *  null صریح = همان تنظیم کاتالوگ (Business.priceValidityDays)؛
   *  undefined = بدون تغییر. مقدار ردیف بر تنظیم کاتالوگ اولویت دارد. */
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(5)
  priceValidDays?: number | null;

  @IsOptional()
  sell?: SellSpecDto;

  @IsOptional()
  buy?: BuySpecDto;

  /** فاز ۳ (طرح ۰۱) — دسته‌ی شخصی کاتالوگ: id یکی از آیتم‌های
   *  Business.customCategories همین کسب‌وکار (اعتبارسنجی سمت سرور).
   *  undefined = بدون تغییر (کلاینتِ کهنه‌ی کش‌شده امن است)؛
   *  null صریح = برداشتن کالا از دسته‌اش. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  catalogCategoryId?: string | null;
}

/**
 * PUT /listings/copyFrom — «کپی از کاتالوگ هم‌صنف‌ها» (خواسته‌ی کاربر:
 * «لیست کالاهای اونو بگیره… هر کدوم رو خواست تیک بزنه و اضافه کنه به
 * کاتالوگ من»). Each source listing lands on MY catalog as a priceless
 * SELL row (قیمت‌گذاری با خودم) carrying the same shared identity keys
 * (productId / brandId / attrs / variantKey) — the same SKU, not a twin.
 */
/**
 * PUT /listings/setActive/:id — فاز ۲: «غیرفعال کردن / فعال‌سازی» کالا.
 * مقدارها دست‌نخورده می‌مانند؛ فقط نمایش در کاتالوگ می‌بندد/باز می‌شود.
 */
export class SetActiveDto {
  @IsBoolean()
  active: boolean;
}

// ── M2 مهاجرت (سند ۰۶ §۲) — تغییر گروهی قیمت/موجودی ──

/** یک قلم تغییر گروهی: قیمت مطلق یا درصدی، موجودی، یا هیچ‌کدام (فقط تمدید). */
export class BulkPriceStockItemDto {
  @IsString()
  @Matches(/^[0-9a-fA-F]{24}$/)
  listingId: string;

  /** قیمت مطلق جدید (کوچک‌ترین واحد ارز) — با pct جدا live می‌کند */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1e12)
  priceMinor?: number;

  /** موجودی جدید */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1e9)
  stock?: number;

  /** درصد تغییر قیمت (+۵ = افزایش ۵٪ / -۳ = کاهش ۳٪) — قانون FD-9:
   *  درصد⇄مبلغ دوگانه؛ اگر هر دو آمدند priceMinor اولویت دارد. */
  @IsOptional()
  @IsNumber()
  @Min(-99)
  @Max(999)
  pct?: number;
}

/**
 * PUT /listings/bulkPriceStock — اسکرین ۳۳: تغییر گروهی قیمت/موجودی و
 * تمدید سریع اعتبار قیمت‌ها. هر قلم: قیمت مطلق یا درصد + موجودی اختیاری؛
 * ردیف بدون هیچ فیلد = فقط «تمدید سریع» (pricedAt = الان).
 */
export class BulkPriceStockDto {
  @IsString()
  businessId: string;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BulkPriceStockItemDto)
  items: BulkPriceStockItemDto[];
}
