import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

/**
 * M6 — اقلام پیشنهاد تامین (FD-23): هر قلم = کالای موردنیاز خریدار +
 * قیمت + حداقل سفارش. قلم بدون قیمت/حداقل در سرور پذیرفته نمی‌شود
 * (مثل شیت فرانت: ناقص = دکمه خاموش) — «فقط درخواست تامین‌کنندگی»
 * یعنی items خالی، نه قلم ناقص.
 */
export class SupplyProposalItemDto {
  @IsString()
  goodId: string;

  /** قیمت هر بسته به minor واحد پایه (ریال) — > 0 الزامی */
  @IsInt()
  @Min(1)
  priceMinor: number;

  /** حداقل سفارش — ≥ ۱ */
  @IsInt()
  @Min(1)
  minOrder: number;
}

/** POST /supply-proposals — تأمین‌کننده از نمای عمومی لیست خرید. */
export class CreateSupplyProposalDto {
  /** کسب‌وکارِ ارسال‌کننده (تأمین‌کننده) — مالکش باید خودِ کاربر باشد */
  @IsString()
  businessId: string;

  /** slug کسب‌وکار خریدار (از مسیر نمای عمومی) */
  @IsString()
  buyerSlug: string;

  /** خالی/غایب = «فقط درخواست تامین‌کنندگی» (bare — بدون قلم قیمت) */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => SupplyProposalItemDto)
  items?: SupplyProposalItemDto[];

  /** یادداشت اختیاری برای خریدار */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** GET /supply-proposals?businessId= — دفترچهٔ پیشنهادهای بازِ دریافتی. */
export class MyProposalsQueryDto {
  @IsString()
  businessId: string;
}
