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

export const GOOD_STATUSES = ["ACTIVE", "PROVISIONAL"] as const;

/**
 * Who registered the row — the admin filter is a single `creator` param:
 * the three real roles, plus SYSTEM for legacy seed rows (no creator).
 */
export const CREATORS = ["USER", "ADMIN", "BRAND_OWNER", "SYSTEM"] as const;

/** GET /admin/goods/list — gardening list (never cached: admin sees live data). */
export class AdminGoodsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;

  @IsOptional()
  @IsIn(GOOD_STATUSES)
  status?: string;

  @IsOptional()
  @IsIn(CREATORS)
  creator?: string;

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

/** POST /admin/goods/create — admin-curated reference good (lands ACTIVE). */
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

/** PATCH /admin/goods/edit/:id — every field optional; only sent keys change. */
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

/** POST /admin/goods/merge/:id — move listings onto the target, delete source. */
export class AdminMergeDto {
  @IsString()
  @MaxLength(40)
  targetId!: string;
}
