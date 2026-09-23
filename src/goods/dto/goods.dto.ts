import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export const TRADE_MODES = ["SELL", "BUY", "BOTH"] as const;
export const FREQUENCIES = ["WEEKLY", "MONTHLY", "OCCASIONAL"] as const;

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

/** POST /goods/createGood — user-created reference good (hidden catalog growth). */
export class CreateGoodDto {
  /** the name the user types — any language, becomes nameFa + searchText */
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @IsString()
  @MaxLength(40)
  categoryId: string;

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

  /** legacy fallback — the leaf's own unit wins when present (auto-prefill contract) */
  @IsOptional()
  @IsString()
  @IsIn(["KILOGRAM", "TON", "CARTON", "SACK", "PIECE", "LITER", "BRANCH", "METER", "GRAM", "SERVICE"])
  unit?: string;
}

/** GET /goods/getBrands — brand suggestions for the listing form. */
export class GetBrandsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;
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
