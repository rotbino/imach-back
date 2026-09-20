import { IsIn, IsOptional, IsString } from "class-validator";
import { BuySpecDto, SellSpecDto, TRADE_MODES } from "../../goods/dto/goods.dto";

/**
 * PUT /listings/saveListing — upsert one listing per (business, good).
 * Spec consistency (SELL needs sell spec, BUY needs buy spec) is enforced
 * in the service because it depends on the mode value.
 */
export class SaveListingDto {
  @IsString()
  businessId: string;

  @IsString()
  goodId: string;

  @IsString()
  @IsIn(TRADE_MODES)
  mode: string;

  @IsOptional()
  sell?: SellSpecDto;

  @IsOptional()
  buy?: BuySpecDto;
}
