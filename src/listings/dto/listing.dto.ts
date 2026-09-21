import { IsIn, IsObject, IsOptional, IsString, MaxLength } from "class-validator";
import { BuySpecDto, SellSpecDto, TRADE_MODES } from "../../goods/dto/goods.dto";

/**
 * PUT /listings/saveListing — upsert one listing per (business, good).
 * Spec consistency (SELL needs sell spec, BUY needs buy spec) is enforced
 * in the service because it depends on the mode value.
 * Currency is NOT taken from the client — it is inherited from the business
 * (which got it from the owner's signup country), so the catalog keeps ONE
 * coherent unit per arm. priceMinor is always the smallest currency unit.
 */
export class SaveListingDto {
  @IsString()
  businessId: string;

  @IsString()
  goodId: string;

  @IsString()
  @IsIn(TRADE_MODES)
  mode: string;

  /** optional brand — free text, resolved/created server-side by normalized name */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  brandName?: string;

  /** category attribute values (weight, packaging …) — shallow string map */
  @IsOptional()
  @IsObject()
  attrs?: Record<string, string>;

  @IsOptional()
  sell?: SellSpecDto;

  @IsOptional()
  buy?: BuySpecDto;
}
