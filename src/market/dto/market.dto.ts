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
 * فاز ۴ مهاجرت (sc-rfq): قیمت هدف + محل تحویل + گروه‌بندی ردیف‌ها با rfqGroupId.
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

  /** فاز ۴ مهاجرت — محل تحویل (پیش‌فرض: شهر خریدار) */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  deliveryCity?: string;

  /** فاز ۴ مهاجرت — قیمت هدف اختیاری (ریال/Minor) */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1e12)
  targetPriceMinor?: number;

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

/** POST /market/sendOffer — price in the smallest currency unit (integer).
 *  فاز ۴ مهاجرت (sc-quote): شرایط پرداخت + زمان تحویل از چیپ‌های فرم. */
export class SendOfferDto {
  @IsString()
  inquiryId: string;

  @IsInt()
  @Min(1)
  @Max(1e12)
  priceMinor: number;

  /** شرایط پرداخت — «نقدی» | «عندالتحویل» | «چک ۳۰ روزه» */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  payTerm?: string;

  /** زمان تحویل — «همان روز» | «فردا» | «۲ روز» */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  delivTerm?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/** POST /market/setOfferStatus/:id — نشان خصوصی خریدار روی پیشنهاد (sheet-offer-status).
 *  "NONE" = حذف نشان (null). فقط خریدارِ خود پیشنهاد مجاز است. */
export class SetOfferStatusDto {
  @IsOptional()
  @IsIn(["INTERESTED", "CONTACTED", "REVIEWED", "NONE"])
  status?: "INTERESTED" | "CONTACTED" | "REVIEWED" | "NONE";
}

/** GET /market/getQuoteContext — زمینهٔ فرم «پاسخ با قیمت» (فاز ۴ مهاجرت).
 *  id = شناسهٔ Inquiry (پاسخ به «به من») یا «b» + شناسهٔ BUY listing
 *  (پاسخ به فرصت بازار / گوش‌به‌زنگ از مسیر offerBuyRequest). */
export class QuoteContextQueryDto extends BusinessIdQueryDto {
  @IsString()
  @MaxLength(40)
  id: string;
}

/** POST /market/followSupplier — ذخیرهٔ کاتالوگ (طرح ۸): خریدار کاتالوگ را
 *  ذخیره می‌کند. source = منبعِ رسیدن (ORGANIC | SHARED | PROMO)؛
 *  promoId فقط وقتی می‌آید که از ردیف پروموی تابلوی ذخیره‌شده ذخیره شده —
 *  سرور رویداد FOLLOW را می‌شمارد و ۵٬۰۰۰ تومان از بودجهٔ کمپین کم می‌کند. */
export class FollowSupplierDto {
  @IsString()
  businessId: string;

  @IsString()
  supplierId: string;

  @IsOptional()
  @IsIn(["ORGANIC", "SHARED", "PROMO"])
  source?: "ORGANIC" | "SHARED" | "PROMO";

  @IsOptional()
  @IsString()
  promoId?: string;
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

  /** فاز ۱۲ — تامین‌کنندهٔ مبدأ (اختیاری): وقتی خریدار کالا را از صفحهٔ
   *  محصول/کاتالوگ یک فروشنده «دنبال می‌کند»، همان فروشنده به‌طور طبیعی
   *  به لیست دنبال‌شده‌های قیمت همان کالا اضافه می‌شود (Follow خودکار). */
  @IsOptional()
  @IsString()
  supplierId?: string;
}

/** POST /market/unwatchGood/:goodId */
export class UnwatchGoodDto {
  @IsString()
  businessId: string;
}

/** POST /market/archiveWatchedGood — فاز ۱۲: آرشیو موقتِ ردیف دفتر خرید.
 *  رصد و تاریخچه می‌ماند؛ فقط از لیست روزمره کنار می‌رود. archived=false = بازگردانی. */
export class ArchiveWatchedGoodDto {
  @IsString()
  businessId: string;

  @IsString()
  goodId: string;

  @IsBoolean()
  archived: boolean;
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
 * «می‌خواهم تامین‌کننده‌ی این خریدار باشم». طرح ۸ (U63): «گوش به زنگ» — به محض نیاز جدید، درخواست در تب گوش‌به‌زنگ فروشنده می‌نشیند.
 */
export class FollowBuyerDto {
  @IsString()
  businessId: string;

  @IsString()
  buyerBusinessId: string;

  @IsOptional()
  @IsIn(["ORGANIC", "SHARED"])
  source?: "ORGANIC" | "SHARED";
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

  /** فاز ۴ مهاجرت (sc-quote) — شرایط پرداخت */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  payTerm?: string;

  /** فاز ۴ مهاجرت (sc-quote) — زمان تحویل */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  delivTerm?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
