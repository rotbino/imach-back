import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { Type } from "class-transformer";
import { IsArray, IsIn, IsNumber, IsObject, IsOptional, IsString } from "class-validator";
import { CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { assertBusinessOwner } from "../common/guards";
import { PrismaService } from "../common/prisma/prisma.module";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PricingService } from "./pricing.service";

class BusinessIdDto {
  @IsString() businessId!: string;
}

class SaveCatalogDto {
  @IsString() businessId!: string;
  @IsObject() custPct!: Record<string, unknown>;
  @IsOptional() @IsArray() tiers?: unknown[];
}

class SaveGroupDto extends SaveCatalogDto {}

class SaveItemDto {
  @IsString() businessId!: string;
  @IsIn(["CATALOG", "CUSTOM"]) mode!: "CATALOG" | "CUSTOM";
  /** ورودی سه‌گانه — {p|h|q: {kind: 'pct'|'amt'|'fin', valueToman}} */
  @IsOptional() @IsObject() tri?: Record<string, unknown>;
  @IsOptional() @IsArray() tiers?: unknown[];
}

class BulkDto {
  @IsString() businessId!: string;
  @IsArray() @IsString({ each: true }) listingIds!: string[];
  @IsIn(["RESET", "SAME"]) action!: "RESET" | "SAME";
  @IsOptional() @IsObject() custPct?: Record<string, unknown>;
}

class PreviewDto {
  @IsString() businessId!: string;
  @IsString() listingId!: string;
  @IsIn(["p", "h", "q"]) custType!: "p" | "h" | "q";
  /** کوئری استرینگ می‌آید — الگوی @Type(() => Number) ریپو (transform فعال) */
  @Type(() => Number)
  @IsNumber()
  qty!: number;
}

class CustTypeDto {
  @IsString() businessId!: string;
  @IsString() buyerId!: string;
  @IsIn(["PASSING", "PARTNER", "CONTRACT"]) type!: "PASSING" | "PARTNER" | "CONTRACT";
}

/**
 * فاز ۵ مهاجرت — قیمت‌گذاری و تخفیف‌ها (sc-discount + شیت‌های صفحهٔ محصول).
 * همهٔ مسیرها مالکیت کسب‌وکار را با assertBusinessOwner گارد می‌کنند.
 */
@Controller("pricing")
@UseGuards(JwtAuthGuard)
export class PricingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService
  ) {}

  /** وضعیت کامل صفحهٔ تخفیف‌ها: کاتالوگ + گروه‌ها + کالاها (با قاعدهٔ هرکدام) */
  @Get("state")
  async state(@Query() q: BusinessIdDto, @CurrentUser() user: AuthUser) {
    await assertBusinessOwner(this.prisma, user, q.businessId, "fa");
    return this.pricing.getState(q.businessId);
  }

  /** ذخیرهٔ قاعدهٔ کاتالوگ — {custPct: {p,h,q}, tiers: [{from,to,pct}]} */
  @Put("catalog")
  async saveCatalog(@Body() body: SaveCatalogDto, @CurrentUser() user: AuthUser) {
    await assertBusinessOwner(this.prisma, user, body.businessId, "fa");
    await this.pricing.saveCatalog(body.businessId, body.custPct, body.tiers);
    return this.pricing.getState(body.businessId);
  }

  /** ذخیرهٔ قاعدهٔ گروه کالا — refId = id آیتم Business.customCategories */
  @Put("group/:refId")
  async saveGroup(@Param("refId") refId: string, @Body() body: SaveGroupDto, @CurrentUser() user: AuthUser) {
    await assertBusinessOwner(this.prisma, user, body.businessId, "fa");
    await this.pricing.saveGroup(body.businessId, refId, body.custPct, body.tiers);
    return this.pricing.getState(body.businessId);
  }

  /** قاعدهٔ کالای مشخص — CATALOG (ریست) یا CUSTOM (ورودی سه‌گانه + پله‌ها) */
  @Put("item/:listingId")
  async saveItem(@Param("listingId") listingId: string, @Body() body: SaveItemDto, @CurrentUser() user: AuthUser) {
    await assertBusinessOwner(this.prisma, user, body.businessId, "fa");
    return this.pricing.saveItem(body.businessId, listingId, body.mode, body.tri, body.tiers);
  }

  /** عملیات گروهی چند کالا — ریست به کاتالوگ یا تخفیف یکسان */
  @Put("bulk")
  async bulk(@Body() body: BulkDto, @CurrentUser() user: AuthUser) {
    await assertBusinessOwner(this.prisma, user, body.businessId, "fa");
    return this.pricing.bulk(body.businessId, body.listingIds, body.action, body.custPct);
  }

  /** پیش‌نمایش قیمت مؤثر — همان عددی که خریدار می‌بیند + شکست منشأ تخفیف‌ها */
  @Get("preview")
  async preview(@Query() q: PreviewDto, @CurrentUser() user: AuthUser) {
    await assertBusinessOwner(this.prisma, user, q.businessId, "fa");
    if (q.qty < 0 || q.qty > 1_000_000) q.qty = Math.max(0, Math.min(1_000_000, q.qty));
    return this.pricing.preview(q.businessId, q.listingId, q.custType, q.qty);
  }

  /** تغییر نوع مشتری (گذری/همکار/قراردادی) — روی یال فالو، توسط فروشنده */
  @Post("custType")
  async setCustType(@Body() body: CustTypeDto, @CurrentUser() user: AuthUser) {
    await assertBusinessOwner(this.prisma, user, body.businessId, "fa");
    return this.pricing.setCustType(body.businessId, body.buyerId, body.type);
  }
}
