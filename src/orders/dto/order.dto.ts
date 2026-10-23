import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

/** قلم سبد کاتالوک — قیمت از آگهیِ زنده فریز می‌شود (۳۱ → POST /orders) */
export class BasketItemDto {
  @IsString()
  listingId: string;

  /** تعداد/مقدار همان آگهی — گیت: حداقل سفارشِ ردیف (FD-26) */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1e9)
  qty: number;
}

/** اصلاح قلم هنگام پذیرش (۱۰) — مقدار/قیمت توافق نهایی */
export class AcceptEditDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1e9)
  qty?: number;

  /** قیمت واحد توافقی (ریال/Minor) — منفی نمی‌پذیریم */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1e12)
  unitPriceMinor?: number;
}

/**
 * POST /orders — ثبت سفارش (سبد کاتالوک ۳۱ · کال‌اوت ۲۷ پیشنهاد پذیرفته‌شده).
 * originType=CATALOG_BASKET ⇒ supplierId + items[] (سبد زنده، قیمت فریز از آگهی).
 * originType=RFQ_OFFER ⇒ offerId (اقلام/قیمت/شرایط از پیشنهادِ برنده فریز می‌شود).
 */
export class CreateOrderDto {
  @IsString()
  businessId: string;

  @IsIn(["CATALOG_BASKET", "RFQ_OFFER"])
  originType: "CATALOG_BASKET" | "RFQ_OFFER";

  @IsOptional()
  @IsString()
  supplierId?: string;

  @IsOptional()
  @IsString()
  offerId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => BasketItemDto)
  items?: BasketItemDto[];

  /** یادداشت خریدار برای فروشنده (سبد) */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class AcceptOrderDto {
  @IsString()
  businessId: string;

  /** اصلاح اقلام — هم‌ترتیب با order.items (فقط فیلدهای ارسالی اعمال می‌شوند) */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => AcceptEditDto)
  edits?: AcceptEditDto[];

  /** یادداشت فروشنده برای مشتری («ارسال فردا صبح، راننده آقای محمدی») */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/** GET /orders?businessId=&side=buy|sell — دفتر سفارش‌ها (۰۹/۲۸) */
export class OrdersQueryDto {
  @IsString()
  businessId: string;

  @IsIn(["buy", "sell"])
  side: "buy" | "sell";

  /** خریدار: بایگانی را می‌بیند (۲۸ بخش دوم) */
  @IsOptional()
  @IsIn(["true", "false"])
  archived?: string;
}

export class OrderIdQueryDto {
  @IsString()
  businessId: string;
}
