import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export const TRADE_MODES = ["SELL", "BUY", "BOTH"] as const;
export const FREQUENCIES = ["WEEKLY", "BIWEEKLY", "MONTHLY", "OCCASIONAL"] as const;

/** GET /goods/getGoods — reference catalog query (cached, cursor-paginated). */
export class GetGoodsQueryDto {
  /** free-text search across Persian/English names + aliases (normalized) */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;

  /** browse by category node (leaf or mid-level) */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** POST /goods/createGood — user-created reference good (hidden catalog growth).
 * categoryId اختیاری است — وقتی ندهند (فرم سرچ‌محور جدید)، کالا به‌صورت خودکار
 * در سبد «سایر › جدید» با واحد عدد ثبت می‌شود و ادمین بعداً جای درستش را می‌دهد
 * (admin edit/:id همین کار را می‌کند) — کاربر هرگز درگیر گروه/زیرگروه/واحد نیست. */
export class CreateGoodDto {
  /** the name the user types — any language, becomes nameFa + searchText */
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  nameEn?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  aliases?: string[];

  /** M4-prep (وفاداری فرم ۱۳ به پروتوتایپ): واحد پایهٔ کالا — فقط وقتی فرم
   *  بدون categoryId صریح می‌آید (سبد «سایر › جدید») معنای واقعی دارد؛ با دستهٔ
   *  صریح، واحد برگِ مرجع مقدم است تا کالاهای یک برگ هم‌واحد بمانند.
   *  مقادیر مجاز = کلیدهای سطح-بالای جدول Unit (baseUnitKey=null). */
  @IsOptional()
  @IsString()
  @IsIn([
    "KILOGRAM", "GRAM", "TON", "METER", "SQUARE_METER", "CUBIC_METER",
    "LITER", "MILLILITER", "WATT", "KWH", "SERVICE", "PIECE", "SET",
    "CAN", "TIN", "BOTTLE", "JAR", "TUBE", "BAG", "SACK", "ROLL",
    "REEL", "COIL", "BALE", "CRATE", "PALLET",
  ])
  unit?: string;
}

/** GET /goods/getBrands — brand suggestions for the listing form.
 * M4-prep: پارامتر limit برای شیت انتخاب برند فرم ثبت کالا (پیش‌فرض همان ۱۰
 * برای استفاده‌های قدیمی؛ سقف ۶۰ — ۳,۷۶۹ برند واقعی فقط با جستجو/اسکرول معنی‌دار است). */
export class GetBrandsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  limit?: number;
}

/** Sell-side spec — price in the SMALLEST currency unit (integer, exact). */
export class SellSpecDto {
  @IsInt()
  @Min(1)
  @Max(1e12)
  priceMinor: number;

  @IsInt()
  @Min(0)
  @Max(1e9)
  stock: number;

  @IsInt()
  @Min(0)
  @Max(1e9)
  minOrder: number;
}

export class BuySpecDto {
  @IsNumber()
  @Min(0.1)
  @Max(1e9)
  volume: number;

  @IsString()
  @IsIn(FREQUENCIES)
  frequency: string;
}
