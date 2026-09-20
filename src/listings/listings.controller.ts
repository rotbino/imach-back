import { Body, Controller, Delete, Get, Param, Put, Query, UseGuards } from "@nestjs/common";
import { CacheService } from "../common/cache/cache.module";
import { CurrentLocale, CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import { assertBusinessOwner } from "../common/guards";
import { t, type Locale } from "../common/i18n/i18n";
import { PrismaService } from "../common/prisma/prisma.module";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { SaveListingDto } from "./dto/listing.dto";

/**
 * Listing = the atomic tradable unit (business × good, unique).
 * Price changes are recorded in PriceLog so the live board can show
 * trends without extra bookkeeping.
 */
@Controller("listings")
@UseGuards(JwtAuthGuard)
export class ListingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService
  ) {}

  private invalidateFor(businessId: string): void {
    this.cache.invalidateTag(`business:${businessId}`);
    this.cache.invalidateTag(`market:board:${businessId}`);
    this.cache.invalidateTag(`market:sugg:${businessId}`);
  }

  @Get("getMyListings")
  async getMyListings(
    @CurrentUser() user: AuthUser,
    @Query("businessId") businessId: string | undefined,
    @CurrentLocale() locale: Locale
  ) {
    if (!businessId) throw AppError.badRequest("businessId is required", "BUSINESS_ID_REQUIRED");
    await assertBusinessOwner(this.prisma, user, businessId, locale);
    return this.prisma.listing.findMany({
      where: { businessId },
      select: {
        id: true,
        mode: true,
        price: true,
        stock: true,
        minOrder: true,
        volume: true,
        frequency: true,
        updatedAt: true,
        good: { select: { id: true, name: true, category: true, unit: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  @Put("saveListing")
  async saveListing(@Body() body: SaveListingDto, @CurrentUser() user: AuthUser, @CurrentLocale() locale: Locale) {
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);

    const good = await this.prisma.good.findUnique({ where: { id: body.goodId }, select: { id: true } });
    if (!good) throw AppError.badRequest("کالای مرجع یافت نشد", "GOOD_NOT_FOUND");

    // Spec consistency: SELL/BOTH require sell spec, BUY/BOTH require buy spec
    if (body.mode !== "BUY" && !body.sell) {
      throw AppError.badRequest("برای فروش، مشخصات قیمت و موجودی الزامی است", "SELL_SPEC_REQUIRED");
    }
    if (body.mode !== "SELL" && !body.buy) {
      throw AppError.badRequest("برای خرید، حجم و تناوب الزامی است", "BUY_SPEC_REQUIRED");
    }

    const data = {
      mode: body.mode,
      ...(body.mode !== "BUY" && body.sell
        ? { price: body.sell.price, stock: body.sell.stock, minOrder: body.sell.minOrder }
        : { price: null, stock: null, minOrder: null }),
      ...(body.mode !== "SELL" && body.buy
        ? { volume: body.buy.volume, frequency: body.buy.frequency }
        : { volume: null, frequency: null }),
    };

    const existing = await this.prisma.listing.findUnique({
      where: { businessId_goodId: { businessId: business.id, goodId: body.goodId } },
      select: { id: true, price: true },
    });

    const listing = await this.prisma.listing.upsert({
      where: { businessId_goodId: { businessId: business.id, goodId: body.goodId } },
      create: { businessId: business.id, goodId: body.goodId, ...data },
      update: data,
      select: {
        id: true,
        mode: true,
        price: true,
        stock: true,
        minOrder: true,
        volume: true,
        frequency: true,
        good: { select: { id: true, name: true, category: true, unit: true } },
      },
    });

    if (existing && existing.price !== null && listing.price !== null && existing.price !== listing.price) {
      await this.prisma.priceLog.create({
        data: { listingId: listing.id, oldPrice: existing.price, newPrice: listing.price },
      });
    }

    this.invalidateFor(business.id);
    return listing;
  }

  @Delete("deleteListing/:id")
  async deleteListing(@Param("id") id: string, @CurrentUser() user: AuthUser, @CurrentLocale() locale: Locale) {
    const listing = await this.prisma.listing.findUnique({
      where: { id },
      select: { id: true, businessId: true },
    });
    if (!listing) throw AppError.notFound("Listing not found");
    await assertBusinessOwner(this.prisma, user, listing.businessId, locale);
    await this.prisma.listing.delete({ where: { id: listing.id } });
    this.invalidateFor(listing.businessId);
    return { ok: true };
  }
}
