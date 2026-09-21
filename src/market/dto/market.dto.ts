import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

/** GET /market/getOffers | getInquiries | getFollows | getPriceBoard | getSuggestions */
export class BusinessIdQueryDto {
  @IsString()
  businessId: string;
}

export class OffersQueryDto extends BusinessIdQueryDto {
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

export class InquiriesQueryDto extends BusinessIdQueryDto {
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

/** GET /market/getHomeFeed — listings of the businesses I follow */
export class HomeFeedQueryDto extends BusinessIdQueryDto {
  @IsOptional()
  @IsIn(["SELL", "BUY"])
  mode?: "SELL" | "BUY";
}

/** POST /market/requestQuote/:listingId */
export class RequestQuoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/** POST /market/sendOffer — price in the smallest currency unit (integer). */
export class SendOfferDto {
  @IsString()
  inquiryId: string;

  @IsInt()
  @Min(1)
  @Max(1e12)
  priceMinor: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/** POST /market/followSupplier */
export class FollowSupplierDto {
  @IsString()
  businessId: string;

  @IsString()
  supplierId: string;
}

/** POST /market/unfollowSupplier/:supplierId */
export class UnfollowSupplierDto {
  @IsString()
  businessId: string;
}
