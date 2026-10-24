import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { Type } from "class-transformer";
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { CurrentLocale, CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import type { Locale } from "../common/i18n/i18n";
import { assertBusinessOwner } from "../common/guards";
import { PrismaService } from "../common/prisma/prisma.module";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RepService, type RepItem } from "./rep.service";

/** ObjectId hex guard — keeps invalid params away from Prisma. */
const isObjectId = (v: string | undefined): v is string => /^[a-f\d]{24}$/i.test(v ?? "");

class RepItemDto implements RepItem {
  @IsString() name!: string;
  @IsOptional() @IsString() pack?: string | null;
  @IsInt() @Min(1) qty!: number;
  @IsInt() @Min(0) unitPriceMinor!: number;
}

class CreateRepOrderDto {
  @IsString() businessId!: string;
  @IsString() customerName!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => RepItemDto) items!: RepItemDto[];
  /** پورسانت توافقی — درصد (۰ < pct ≤ ۱۰۰) */
  @IsInt() @Min(1) @Max(100) commissionPct!: number;
}

class RepOrderBodyDto {
  @IsString() businessId!: string;
}

class ShareRepOrderDto {
  @IsString() businessId!: string;
  @IsIn(["WHATSAPP", "SMS", "CLIPBOARD"]) via!: "WHATSAPP" | "SMS" | "CLIPBOARD";
}

/**
 * M9 — داشبورد نمایندهٔ فروش (FD-17 · فضای سوم). این سفارش‌ها «بیرون از
 * سیستم» تأمین می‌شوند: نماینده لیست را با پیام‌رسان/کپی برای تأمین‌کننده
 * می‌فرستد و پورسانت توافقی را همان‌جا می‌گیرد — آی‌مچ فقط ردیابی و
 * گزارش می‌کند؛ پول بیرون از شبکهٔ پرداخت آی‌مچ جابه‌جا می‌شود.
 */
@Controller("rep")
@UseGuards(JwtAuthGuard)
export class RepController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rep: RepService,
  ) {}

  /** ثبت سفارش نماینده — قلم‌های آزاد (نام/بسته/تعداد/قیمت) + پورسانت */
  @Post("orders")
  async create(@Body() body: CreateRepOrderDto, @CurrentUser() user: AuthUser, @CurrentLocale() locale: Locale) {
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    return this.rep.create(user.id, business.id, body.customerName, body.items, body.commissionPct);
  }

  /** گزارش واحد سفارش‌ها — ?businessId= فیلتر همان کسب‌وکار (حکم مالک) */
  @Get("orders")
  async list(
    @Query("businessId") businessId: string | undefined,
    @CurrentUser() user: AuthUser
  ) {
    // فیلتر هم مالکیت دارد — کاربر نمی‌تواند میز دیگران را فیلتر کند
    let filter: string | undefined;
    if (businessId && isObjectId(businessId)) {
      const biz = await this.prisma.business.findUnique({
        where: { id: businessId },
        select: { ownerId: true },
      });
      if (!biz || biz.ownerId !== user.id) {
        filter = undefined; // بی‌اثر — نه خطا؛ گزارشِ خودش برمی‌گردد
      } else {
        filter = businessId;
      }
    }
    return this.rep.list(user.id, filter);
  }

  /** داشبورد — ۴ کاشی ماه جاری + کسب‌وکارهای زیر نمایندگی با آمار */
  @Get("stats")
  async stats(@CurrentUser() user: AuthUser) {
    return this.rep.stats(user.id);
  }

  /** ارسال لیست سفارش — بیرون از سیستم؛ متنِ لیست برای پیام‌رسان برمی‌گردد */
  @Post("orders/:id/share")
  async share(
    @Param("id") id: string,
    @Body() body: ShareRepOrderDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    if (!isObjectId(id)) throw new Error("REP_NOT_FOUND");
    await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    return this.rep.share(user.id, id, body.via);
  }

  /** تحویل شد — پورسانت در انتظار */
  @Post("orders/:id/deliver")
  async deliver(
    @Param("id") id: string,
    @Body() body: RepOrderBodyDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    if (!isObjectId(id)) throw new Error("REP_NOT_FOUND");
    await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    return this.rep.deliver(user.id, id);
  }

  /** پورسانت دریافت شد — تسویه */
  @Post("orders/:id/settle")
  async settle(
    @Param("id") id: string,
    @Body() body: RepOrderBodyDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    if (!isObjectId(id)) throw new Error("REP_NOT_FOUND");
    await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    return this.rep.settle(user.id, id);
  }
}
