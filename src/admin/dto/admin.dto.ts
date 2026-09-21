import { Type } from "class-transformer";
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export const GOOD_UNITS = [
  "KILOGRAM",
  "TON",
  "CARTON",
  "SACK",
  "PIECE",
  "LITER",
  "BRANCH",
  "METER",
  "GRAM",
  "SERVICE",
] as const;

export const GOOD_SOURCES = ["SEED", "USER"] as const;
export const GOOD_STATUSES = ["ACTIVE", "PROVISIONAL"] as const;

/** GET /admin/getGoods — gardening list (never cached: admin sees live data). */
export class AdminGoodsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;

  @IsOptional()
  @IsIn(GOOD_STATUSES)
  status?: string;

  @IsOptional()
  @IsIn(GOOD_SOURCES)
  source?: string;

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

/** POST /admin/createGood — admin-seeded reference good. */
export class AdminCreateGoodDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  nameFa!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  nameEn?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  aliases?: string[];

  @IsString()
  @IsIn(GOOD_UNITS)
  unit!: string;

  @IsString()
  @MaxLength(40)
  categoryId!: string;
}

/** PATCH /admin/editGood/:id — every field optional; only sent keys change. */
export class AdminEditGoodDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  nameFa?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  nameEn?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(10, { each: true })
  aliases?: string[];

  @IsOptional()
  @IsString()
  @IsIn(GOOD_UNITS)
  unit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  categoryId?: string;

  @IsOptional()
  @IsIn(GOOD_STATUSES)
  status?: string;
}

/** POST /admin/mergeGood/:id — move listings onto the target, delete source. */
export class AdminMergeDto {
  @IsString()
  @MaxLength(40)
  targetId!: string;
}

/** GET /admin/getBrands — gardening list for auto-resolved brands. */
export class AdminBrandsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;

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
