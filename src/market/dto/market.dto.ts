import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

/** GET /market/getOffers | getInquiries | getFollows | getPriceBoard | getFollowers | getSupplierSuggestions | getBuyRequests */
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

/** POST /market/removeFollower — catalog owner removes a follower from «مشتریان من». */
export class RemoveFollowerDto {
  @IsString()
  businessId: string;

  @IsString()
  followerBusinessId: string;
}

/**
 * POST /market/followBuyer — my SELL page follows a buyer's BUY desk:
 * «می‌خواهم تامین‌کننده‌ی این خریدار باشم». Gated behind the referral target.
 */
export class FollowBuyerDto {
  @IsString()
  businessId: string;

  @IsString()
  buyerBusinessId: string;
}

/**
 * POST /market/offerBuyRequest — a gated cold price offer on a buyer's
 * purchase request. Backed by MY sell listing of the same good, so it lands
 * in the buyer's existing «پیشنهادهای دریافتی» stream.
 */
export class OfferBuyRequestDto {
  @IsString()
  businessId: string;

  @IsString()
  buyListingId: string;

  @IsInt()
  @Min(1)
  @Max(1e12)
  priceMinor: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
