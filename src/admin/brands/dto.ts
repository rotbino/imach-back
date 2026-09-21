import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export const BRAND_STATUSES = ["ACTIVE", "PROVISIONAL"] as const;

/** GET /admin/brands/list — gardening list (never cached: admin sees live data). */
export class AdminBrandsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;

  @IsOptional()
  @IsIn(BRAND_STATUSES)
  status?: string;

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

/** POST /admin/brands/create — admin-curated brand (lands ACTIVE). */
export class AdminCreateBrandDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;
}

/** PATCH /admin/brands/edit/:id — approve (PROVISIONAL → ACTIVE). */
export class AdminEditBrandDto {
  @IsOptional()
  @IsIn(BRAND_STATUSES)
  status?: string;
}

/** POST /admin/brands/merge/:id — move listings onto the target, delete source. */
export class AdminMergeBrandDto {
  @IsString()
  @MaxLength(40)
  targetId!: string;
}
