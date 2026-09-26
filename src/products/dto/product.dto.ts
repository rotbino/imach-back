import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";
import { Type } from "class-transformer";

/**
 * Products = the shared SKU layer (برند×وزن×بسته‌بندی) between Good and
 * Listing — see the Product model docs for the full contract.
 * The PICKER («از کاتالوگ انتخاب کن») reads this endpoint; retailers with
 * hundreds of items tick from here instead of typing each SKU from scratch.
 */

/** GET /products/getProducts — picker feed (auth, user-specific badges). */
export class GetProductsQueryDto {
  /** free text — matches product label OR its reference good name */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;

  /** category leaf — the picker's browse chips */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  categoryId?: string;

  /** all products of one reference good */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  goodId?: string;

  /** brand filter — the picker's «فقط این برند» (خواسته‌ی کاربر: فیلتر برند
   * در کنار دسته، خودِ راه پیدا کردن لیستِ مناسب است) */
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-fA-F]{24}$/)
  brandId?: string;

  /** exact barcode (GTIN/EAN) — the scanner's fast path; indexed lookup,
   * returns the one matching SKU instantly even at millions scale */
  @IsOptional()
  @IsString()
  @Matches(/^[0-9A-Za-z\-]{4,20}$/)
  barcode?: string;

  /** the caller's business — feeds the «داریش» badge; must be owned.
   * Optional for ADMIN (the gardening panel searches the shared table). */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  businessId?: string;

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

/** PUT /products/adminMerge — collapse fragmented identities into one survivor. */
export class AdminMergeDto {
  @IsString()
  intoId: string;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  fromIds: string[];
}

/** PUT /listings/bulkSave — one picker confirmation → N listings. */
export class BulkSaveItemDto {
  @IsString()
  productId: string;

  /** sell arm — minor units; OPTIONAL by design: scanner/import rows may
   * land priceless first («همه رو اسکن کن، بعد قیمت‌ها رو بده») and the
   * catalog shows them in the «نیاز به تکمیل قیمت» tray until priced. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  priceMinor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stock?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minOrder?: number;

  /** buy arm — OPTIONAL on purpose: «تیک بزن، مقدارش را بعداً بده» — the buy
   * list forms gradually (خواسته‌ی کاربر); volume=null rows show with a
   * «مقدار بعداً» badge. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  volume?: number;

  @IsOptional()
  @IsIn(["WEEKLY", "MONTHLY", "OCCASIONAL"])
  frequency?: string;
}

export class BulkSaveDto {
  @IsString()
  businessId: string;

  /** BOTH = the scanner's «هم فروش و هم خرید» — one row carrying both arms */
  @IsIn(["SELL", "BUY", "BOTH"])
  mode: string;

  @IsArray()
  @ArrayMaxSize(200)
  @Type(() => BulkSaveItemDto)
  items: BulkSaveItemDto[];
}

/** POST /products/importCommit — the rows the user confirmed in the preview. */
export class ImportRowDto {
  /** 1-based row number from the user's file — echoed back in skipped[] */
  @Type(() => Number)
  @IsInt()
  index: number;

  @IsString()
  @MaxLength(80)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  brand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  spec?: string;

  /** minor units (already converted on the preview step) */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  priceMinor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stock?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minOrder?: number;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  volume?: number;

  /** «لینک عکس» column — a direct image URL the server fetches once on
   * commit and runs through the same gallery pipeline (خواسته‌ی کاربر:
   * «ای کاش می‌شد از اکسل تصاویر رو هم وارد کرد»). Failure never fails the
   * row — the listing saves imageless and the user adds the photo later. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  subcategory?: string;
}

export class ImportCommitDto {
  @IsString()
  businessId: string;

  /** the arm the user opened the sheet from — per-row arms still win: a row
   * with sell price AND buy volume becomes a single BOTH row */
  @IsIn(["SELL", "BUY"])
  mode: string;

  @IsArray()
  @ArrayMaxSize(2000)
  @Type(() => ImportRowDto)
  rows: ImportRowDto[];
}
