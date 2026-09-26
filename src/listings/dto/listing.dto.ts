import { IsArray, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, ArrayMaxSize } from "class-validator";
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

  /** shared SKU (the picker's pick) — validated server-side against goodId;
   * omitted → identity is derived silently from brandName+attrs */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  productId?: string;

  /** the exact row being edited — when present the save UPDATES this row in
   * place (id, gallery and price history survive) instead of upserting by
   * identity key. Without it, a legacy row would fork into an imageless twin. */
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-fA-F]{24}$/)
  listingId?: string;

  /** category attribute values (weight, packaging …) — shallow string map */
  @IsOptional()
  @IsObject()
  attrs?: Record<string, string>;

  /** human-friendly product label — user can type a custom display name.
   *  If omitted, the system auto-generates one from goodName + brand + attrs.
   *  The machine identity (searchText) is ALWAYS auto-derived from brand +
   *  attrs — this label is only for display and search. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  productLabel?: string;

  @IsOptional()
  sell?: SellSpecDto;

  @IsOptional()
  buy?: BuySpecDto;
}

/**
 * PUT /listings/copyFrom — «کپی از کاتالوگ هم‌صنف‌ها» (خواسته‌ی کاربر:
 * «لیست کالاهای اونو بگیره… هر کدوم رو خواست تیک بزنه و اضافه کنه به
 * کاتالوگ من»). Each source listing lands on MY catalog as a priceless
 * SELL row (قیمت‌گذاری با خودم) carrying the same shared identity keys
 * (productId / brandId / attrs / variantKey) — the same SKU, not a twin.
 */
export class CopyFromDto {
  @IsString()
  businessId: string;

  @IsString()
  sourceBusinessId: string;

  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  sourceListingIds: string[];
}
