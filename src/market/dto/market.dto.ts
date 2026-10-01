import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

/** GET /market/getInquiries | getFollows | getPriceBoard | getFollowers | getBuyRequests */
export class BusinessIdQueryDto {
  @IsString()
  businessId: string;
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

/** GET /market/getSupplyBoard — تابلوی تأمین یک کالا (فاز ۶ · طرح ۰۹ · شکاف ۵) */
export class SupplyBoardQueryDto extends BusinessIdQueryDto {
  @IsString()
  goodId: string;
}

/**
 * POST /market/requestQuote — فرم درخواست قیمت از تابلوی تأمین (فاز ۶ · طرح ۱۲ · شکاف ۴).
 * جایگزینِ requestQuote/:listingId خودکارِ قدیمی است: گیرندگان این‌جا انتخابی‌اند.
 */
export class RequestQuoteDto {
  @IsString()
  businessId: string;

  @IsString()
  goodId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1e9)
  volume: number;

  @IsOptional()
  @IsIn(["WEEKLY", "MONTHLY", "OCCASIONAL"])
  frequency?: string;

  /** انتظار تحویل — «فوری» | «این ماه» (متن آزاد کوتاه از فرم) */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  delivery?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  /** تأمین‌کننده‌های انتخاب‌شده از تابلو — businessId ها */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  supplierIds?: string[];

  /** بقیه ظرفیت با موتور تطبیق پر شود (رفتار «شبکه iMach» در فرم) */
  @IsOptional()
  @IsBoolean()
  includeNetwork?: boolean;
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

/** POST /market/watchGood — فاز ۵ (طرح ۰۸/۰۲): دنبال‌کردن قیمت یک کالا */
export class WatchGoodDto {
  @IsString()
  businessId: string;

  @IsString()
  goodId: string;
}

/** POST /market/unwatchGood/:goodId */
export class UnwatchGoodDto {
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
