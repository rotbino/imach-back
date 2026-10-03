import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsInt, IsString, Min } from "class-validator";
import { CurrentLocale, CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import type { Locale } from "../common/i18n/i18n";
import { assertBusinessOwner } from "../common/guards";
import { PrismaService } from "../common/prisma/prisma.module";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PromosService } from "./promos.service";

class CreatePromoDto {
  @IsString() businessId!: string;
  @IsString() listingId!: string;
  /** بودجه به تومان — سرور به minor ریال تبدیل می‌کند */
  @IsInt() @Min(50_000) budgetToman!: number;
}

class StopPromoDto {
  @IsString() businessId!: string;
}

class PromoQueryDto {
  @IsString() businessId!: string;
}

/**
 * طرح ۸ — کمپین «صف اول» (U05..U09). شفافیت آهنین:
 * نرخ‌ها (۱٬۰۰۰ ت نمایش / ۵٬۰۰۰ ت ذخیره) هم در شیت ساخت و هم در
 * گزارش نوشته می‌شوند؛ هدف‌گیری فقط غیرذخیره‌کنندگان است و رتبهٔ
 * تطبیق مستقل از پرداخت می‌ماند (برچسب ⭐ شفاف).
 */
@Controller("promos")
@UseGuards(JwtAuthGuard)
export class PromosController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly promos: PromosService,
  ) {}

  /** ساخت کمپین — بودجه از کیف قفل می‌شود؛ نمایش فوراً شروع می‌شود */
  @Post("create")
  async create(@Body() body: CreatePromoDto, @CurrentUser() user: AuthUser, @CurrentLocale() locale: Locale) {
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    try {
      const promo = await this.promos.create(
        business.id,
        body.listingId,
        body.budgetToman * 10 // تومان → ریال
      );
      return promo;
    } catch (e) {
      const code = e instanceof Error ? e.message : "PROMO_FAILED";
      const msg: Record<string, string> = {
        PROMO_LISTING_NOT_YOURS: "این کالا در کاتالوگ فروش شما نیست",
        PROMO_LISTING_NOT_SELLING: "کالای غیرفعال یا غیرفروشی کمپین نمی‌شود",
        PROMO_ALREADY_RUNNING: "برای این کالا کمپین فعالی دارید",
        PROMO_INSUFFICIENT_BALANCE: "موجودی کیف پول برای این بودجه کافی نیست",
      };
      throw AppError.badRequest(msg[code] ?? "کمپین ساخته نشد", code);
    }
  }

  /** توقف — باقیماندهٔ بودجه به کیف برمی‌گردد */
  @Post("stop/:promoId")
  async stop(
    @Param("promoId") promoId: string,
    @Body() body: StopPromoDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    try {
      return await this.promos.stop(promoId, business.id);
    } catch {
      throw AppError.badRequest("این کمپین مال شما نیست", "PROMO_NOT_YOURS");
    }
  }

  /** گزارش عددی — مشاهده‌ها، ذخیره‌ها، هزینه، بینندگان (U64) */
  @Get("report")
  async report(
    @Query("promoId") promoId: string,
    @Query() query: PromoQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    try {
      return await this.promos.report(promoId, business.id);
    } catch {
      throw AppError.badRequest("این کمپین مال شما نیست", "PROMO_NOT_YOURS");
    }
  }

  /** لیست کمپین‌های من + آمار فشرده */
  @Get("mine")
  async mine(@Query() query: PromoQueryDto, @CurrentUser() user: AuthUser, @CurrentLocale() locale: Locale) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    const rows = await this.promos.myPromos(business.id);
    // فشرده برای کارت‌ها — جزئیات از report
    return rows.map((p) => ({
      id: p.id,
      listingId: p.listingId,
      goodName: p.listing?.good?.nameFa ?? null,
      priceMinor: p.listing?.priceMinor ?? null,
      budgetMinor: p.budgetMinor,
      spentMinor: p.spentMinor,
      remainingMinor: p.budgetMinor - p.spentMinor,
      isActive: p.isActive,
      eventCount: p._count.events,
      createdAt: p.createdAt,
      stoppedAt: p.stoppedAt,
    }));
  }
}
