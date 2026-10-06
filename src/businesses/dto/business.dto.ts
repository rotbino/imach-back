import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  Max,
  Min,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  Matches,
  IsBoolean,
} from "class-validator";
import { Type } from "class-transformer";

/**
 * نوع فعالیت کسب‌وکار — ۱۰ مقدار دقیق.
 * در ثبت‌نام پرسیده نمی‌شود؛ کاربر هر وقت خواست از پنل انتخاب می‌کند.
 */
export const ACTIVITY_TYPES = [
  "PRODUCER", // تولیدکننده
  "WHOLESALER", // عمده‌فروش
  "RETAILER", // خرده‌فروش
  "DISTRIBUTOR", // پخش‌کننده
  "MERCHANT", // بازرگان
  "SALES_AGENT", // نماینده فروش
  "MARKETER", // بازاریاب
  "SERVICE_PROVIDER", // ارائه‌دهنده خدمات
  "CONTRACTOR", // پیمانکار
  "BUSINESS_CONSUMER", // مصرف‌کننده تجاری
] as const;

export class CreateBusinessDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name: string;

  @IsString()
  @MinLength(2)
  @MaxLength(30)
  city: string;

  /** صنف — free text («سوپرمارکت»)؛ درگاه «کپی از کاتالوگ هم‌صنف‌ها» */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  trade?: string;

  /** فاز ۹ (د۹) — نقشِ ثبت‌نام فقط پیش‌فرضِ دستیارها را می‌گذارد:
   *  sell → فروش روشن/خرید خاموش · buy → خرید روشن/فروش خاموش ·
   *  both (یا غایب) → هر دو روشن. بعداً از پروفایل قابل تغییر است. */
  @IsOptional()
  @IsIn(["sell", "buy", "both"])
  intent?: "sell" | "buy" | "both";
}

export class EditBusinessDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(30)
  city?: string;

  @IsOptional()
  @IsIn(ACTIVITY_TYPES)
  activityType?: string | null;

  /** صنف — free text؛ null = پاک کردن؛ نبودِ فیلد = بدون تغییر */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  trade?: string | null;

  /** لوکیشن دقیق — اختیاری و با رضایت کاربر؛ مبنای لایه‌ی فاصله‌ی تطابق.
   *  null = پاک کردن؛ نبودِ فیلد = بدون تغییر. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number | null;

  /** آدرس متنی — از روی پین پیش‌پر می‌شود ولی همیشه قابل ویرایش است؛
   *  برخلاف پین، این یکی علنی است. null = پاک کردن. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string | null;

  /** فاز ۶ مهاجرت (sc-edit-biz) — شمارهٔ تماس روی کاتالوگ و صفحهٔ کالاها.
   *  null صریح = پاک کردن؛ نبودِ فیلد = بدون تغییر. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string | null;

  /** فاز ۶ مهاجرت (sc-settings «فروشگاه») — ساعت پاسخگویی. null = پاک کردن. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  hours?: string | null;

  /** فاز ۶ مهاجرت (sc-settings «فروشگاه») — شرایط پرداخت پیش‌فرض. null = پاک کردن. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  defaultPayTerm?: string | null;

  /** فاز ۱۳ (بازخورد مالک) — معرفی کوتاه فروشنده؛ زیر نامش در کاتالوگ عمومی.
   *  null صریح = پاک کردن؛ نبودِ فیلد = بدون تغییر. */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  bio?: string | null;
}

/**
 * فاز ۸ (طرح ۱۴) — تنظیمات اعلانِ یک کسب‌وکار، از پروفایل.
 * هر فیلد فقط false صریح را «خاموش» می‌کند؛ غایب = بدون تغییر.
 * کل چهار کلید اختیاری‌اند تا فرانت بتواند هر toggle را جدا ذخیره کند.
 */
export class NotifPrefsDto {
  /** PRICE_CHANGE — «تغییر قیمت در تابلوهای من» */
  @IsOptional()
  @IsBoolean()
  priceChange?: boolean;

  /** QUOTE + OFFER — «پاسخ درخواست‌های قیمت» */
  @IsOptional()
  @IsBoolean()
  quoteReplies?: boolean;

  /** FOLLOW_* + CONTACT_JOINED — «پیشنهادهای جدید iMach» */
  @IsOptional()
  @IsBoolean()
  suggestions?: boolean;

  /** فقط پوشِ وب خاموش می‌شود؛ ردیفِ درون‌برنامه‌ای می‌ماند */
  @IsOptional()
  @IsBoolean()
  push?: boolean;
}

/**
 * فاز ۹ (شکاف ۶ — د۹) — دستیارهای فعالِ کسب‌وکار، از پروفایل.
 * هر فیلد فقط false صریح را «خاموش» می‌کند؛ غایب = بدون تغییر.
 * هر دو اختیاری‌اند تا فرانت هر سوییچ را جدا ذخیره کند؛ ولی نتیجه‌ی
 * نهایی نباید هر دو خاموش شود — سرور 400 می‌دهد (ARMS_REQUIRED).
 */
export class SetArmsDto {
  /** دستیار فروش عمده (کاتالوگ + درخواست‌های قیمت) */
  @IsOptional()
  @IsBoolean()
  sell?: boolean;

  /** دستیار خرید عمده (لیست خرید + تابلوی تأمین) */
  @IsOptional()
  @IsBoolean()
  buy?: boolean;
}

/**
 * PUT /businesses/catalogCategories/:id — فاز ۳ (طرح ۰۱): دسته‌های شخصی
 * کاتالوگ. فروشنده ویترینش را خودش گروه‌بندی می‌کند — «هاشمی/طارم/فجر/
 * صدری» برای برنج‌فروش، «میلگرد/مقطعات/ورق» برای آهن‌فروش. کل لیست یکجا
 * جایگزین می‌شود تا create/rename/reorder/delete همه با یک فراخوان
 * idempotent باشند؛ id را کلاینت می‌سازد و آگهی‌ها با آن اشاره می‌کنند.
 */
export class CatalogCategoryItemDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{1,40}$/, { message: "دسته: id نامعتبر" })
  id: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name: string;
}

export class CatalogCategoriesDto {
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CatalogCategoryItemDto)
  categories: CatalogCategoryItemDto[];
}
