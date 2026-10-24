import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from "class-validator";
import { CurrentLocale, CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import type { Locale } from "../common/i18n/i18n";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OptionalJwtGuard } from "../auth/optional-jwt.guard";
import { ReviewsService } from "./reviews.service";

class UpsertReviewDto {
  @IsString() businessId!: string;
  @IsInt() @Min(1) @Max(5) rating!: number;
  @IsOptional() @IsString() @MaxLength(700) text?: string;
}

class ReplyDto {
  @IsString() @Length(1, 700) reply!: string;
}

/**
 * M10 — نظرات و امتیاز کاتالوگ (سند ۰۶ §reviews · سند ۰۳ §۴.۱).
 * خواندن عمومی (شیت نظرات ۳۱/۳۷)؛ ثبت و پاسخ احرازشده.
 */
@Controller("reviews")
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  /** خلاصه + ریز نظرات یک کاتالوگ — بینندهٔ احرازشده نظر خودش را هم می‌بیند */
  @Get()
  @UseGuards(OptionalJwtGuard)
  async list(
    @Query("businessId") businessId: string,
    @CurrentUser() user: AuthUser | undefined
  ) {
    return this.reviews.list(businessId, user);
  }

  /** ثبت/به‌روزرسانی نظر خریدار — یک نظر به ازای هر کاتالوگ (upsert) */
  @Post()
  @UseGuards(JwtAuthGuard)
  async upsert(
    @Body() body: UpsertReviewDto,
    @CurrentUser() user: AuthUser
  ) {
    return this.reviews.upsert(user, body.businessId, body.rating, body.text ?? null);
  }

  /** پاسخ عمومی فروشنده زیر همان نظر */
  @Post(":id/reply")
  @UseGuards(JwtAuthGuard)
  async reply(
    @Param("id") id: string,
    @Body() body: ReplyDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    return this.reviews.reply(user, id, body.reply, locale);
  }
}
