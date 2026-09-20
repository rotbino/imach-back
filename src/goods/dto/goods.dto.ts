import { Type } from "class-transformer";
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from "class-validator";

export const TRADE_MODES = ["SELL", "BUY", "BOTH"] as const;
export const FREQUENCIES = ["WEEKLY", "MONTHLY", "OCCASIONAL"] as const;

/** GET /goods/getGoods — reference catalog query (cached, cursor-paginated). */
export class GetGoodsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  category?: string;

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

export class SellSpecDto {
  @IsNumber()
  @Min(1)
  @Max(1e12)
  price: number;

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
