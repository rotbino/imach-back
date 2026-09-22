import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  Max,
  Min,
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
}

/** اکسپلور — سمت بازار (فروش/خرید) و شهرِ ترجیحی برای چیدمان */
export class ExploreQueryDto {
  @IsOptional()
  @IsIn(["SELL", "BUY"])
  mode?: "SELL" | "BUY";

  @IsOptional()
  @IsString()
  @MaxLength(30)
  city?: string;
}
