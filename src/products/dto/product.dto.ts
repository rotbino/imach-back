import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
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

  /** the caller's business — feeds the «داریش» badge; must be owned */
  @IsString()
  businessId: string;

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

  /** sell arm — minor units; required when mode=SELL (validated service-side) */
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

  @IsIn(["SELL", "BUY"])
  mode: string;

  @IsArray()
  @ArrayMaxSize(200)
  @Type(() => BulkSaveItemDto)
  items: BulkSaveItemDto[];
}
