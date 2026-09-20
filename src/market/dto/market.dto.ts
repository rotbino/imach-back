import { Type } from "class-transformer";
import { IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

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

/** POST /market/requestQuote/:listingId */
export class RequestQuoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/** POST /market/sendOffer */
export class SendOfferDto {
  @IsString()
  inquiryId: string;

  @IsNumber()
  @Min(1)
  @Max(1e12)
  price: number;

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
