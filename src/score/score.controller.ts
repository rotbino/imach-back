import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.module";
import { CurrentLocale, CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import type { Locale } from "../common/i18n/i18n";
import { assertBusinessOwner } from "../common/guards";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ScoreService } from "./score.service";
import { BusinessIdQueryDto } from "./dto/score.dto";

/**
 * M7 — امتیاز، رشد و اعلان‌ها (سند ۰۸ §M7):
 *   GET /score            → دو بازو + آیتم‌ها + گام بعدی میز + موتور فعال
 *   GET /score/referrals  → صفحهٔ دعوت‌شدگان (آمار/هدف/لیست + پاداش کیف)
 */
@Controller("score")
@UseGuards(JwtAuthGuard)
export class ScoreController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly score: ScoreService
  ) {}

  @Get()
  async getScore(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    return this.score.getScore(business.id);
  }

  @Get("referrals")
  async getReferrals(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    return this.score.getReferrals(business.id);
  }
}
