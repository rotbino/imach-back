import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

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
 *
 * M4 — استعلام چندقلمی (FD-24): items[] می‌آید و goodId/volume تک‌قلمی میراث
 * است (کلاینت قدیم). چندقلمی ⇒ گیرندگان = اجتماع دارندگان قلم‌ها (تیک قفل).
 */
export class RfqItemDto {
  @IsString()
  goodId: string;

  /** مقدار خرید همان قلم (استپر فرم ۲۵) */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1e9)
  qty: number;

  /** واریانت هدف اختیاری (C4) — بهترین نرمال خالی */
  @IsOptional()
  @IsString()
  listingId?: string;
}

export class RequestQuoteDto {
  @IsString()
  businessId: string;

  /** M4 — سبد چندقلمی؛ خالی = مسیر تک‌قلمی legacy (goodId+volume) */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @Type(() => RfqItemDto)
  @IsObject({ each: true })
  items?: RfqItemDto[];

  @IsOptional()
  @IsString()
  goodId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1e9)
  volume?: number;

  /** M4 — مهلت پاسخ ۱..۵ روز (پیش‌فرض ۳ — pills فرم ۲۵) */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  expiresDays?: number;

  @IsOptional()
  @IsIn(["WEEKLY", "BIWEEKLY", "MONTHLY", "OCCASIONAL"])
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
 *  فاز ۴ مهاجرت (sc-quote): شرایط پرداخت + زمان تحویل از چیپ‌های فرم.
 *  M4 — چندقلمی: prices[] هم‌ترتیب با Inquiry.items (null = ندارد) +
 *  شرایط ساختاریافته pay {chk, days} / dlv {ship, by} (سوییچ‌های فرم ۱۲). */
export class SendOfferDto {
  @IsString()
  inquiryId: string;

  /** قیمت قلم اول (legacy) — پیش‌فرض وقتی prices نیامده */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1e12)
  priceMinor?: number;

  /** M4 — قیمت هر قلم هم‌ترتیب با اقلام استعلام؛ null = این قلم را نمی‌دهد
   *  (اعتبارسنجی ساختاری در کنترلر: طول/هم‌ترتیبی/قلمِ نداشتی) */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  prices?: Array<number | null>;

  /** M4 — شرایط پرداخت: {chk: ۰..۹۹, days} — chk=0 یعنی تمام‌نقدی */
  @IsOptional()
  @IsObject()
  pay?: { chk?: number; days?: number };

  /** M4 — شرایط تحویل: {ship, by: "seller"|"customer"} — ship=false حضوری */
  @IsOptional()
  @IsObject()
  dlv?: { ship?: boolean; by?: string };

  /** شرایط پرداخت — «نقدی» | «عندالتحویل» | «چک ۳۰ روزه» (legacy متنی) */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  payTerm?: string;

  /** زمان تحویل — «همان روز» | «فردا» | «۲ روز» (legacy متنی) */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  delivTerm?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/** POST /market/acceptOffer/:id — پذیرش پیشنهاد (۲۷): استعلام می‌بندد + نتیجه */
export class AcceptOfferDto {
  @IsString()
  businessId: string;
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

/** POST /market/setLowStock — M3 مهاجرت (سند ۰۸ §۷): پرچم «در حال اتمام
 *  موجودی» روی ردیف لیست خرید (۲۰ج). اگر ردیف WatchedGood نبود (کالا فقط
 *  با BUY listing در لیست است)، ساخته می‌شود تا پرچم جا بگیرد. */
export class SetLowStockDto {
  @IsString()
  businessId: string;

  @IsString()
  goodId: string;

  @IsBoolean()
  lowStock: boolean;
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
