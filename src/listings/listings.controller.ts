import { Body, Controller, Delete, Get, Param, Put, Query, UseGuards } from "@nestjs/common";
import { goodSearchText } from "../common/catalog/catalog";
import { CacheService } from "../common/cache/cache.module";
import { CurrentLocale, CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import { assertBusinessOwner } from "../common/guards";
import { t, type Locale } from "../common/i18n/i18n";
import { PrismaService } from "../common/prisma/prisma.module";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { SaveListingDto } from "./dto/listing.dto";

/** shallow {key: value} sanity cap for category attributes */
function sanitizeAttrs(attrs: Record<string, string> | undefined): Record<string, string> | null {
  if (!attrs) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs).slice(0, 12)) {
    if (typeof v !== "string") continue;
    if (!k || k.length > 40 || v.length > 80) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Listing = the atomic tradable unit (business × good, unique).
 * Price lives in `priceMinor` (smallest currency unit, integer) + `currency`
 * inherited from the business. Price changes are recorded in PriceLog so the
 * live board can show trends without extra bookkeeping.
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
    this.cache.invalidateTag(`market:ssugg:${businessId}`);
    this.cache.invalidateTag(`market:home:${businessId}`);
    this.cache.invalidateTag(`market:buyreq:${businessId}`);
    this.cache.invalidateTag(`market:selloff:${businessId}`);
  }

  /** resolve free-text brand → deduped Brand row (created on the fly); empty → detached */
  private async resolveBrandId(brandName: string | undefined): Promise<string | null> {
    const name = brandName?.trim();
    if (!name) return null;
    const searchText = goodSearchText({ nameFa: name });
    const brand = await this.prisma.brand.upsert({
      where: { searchText },
      create: { name, searchText, source: "USER" },
      update: {},
      select: { id: true },
    });
    return brand.id;
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
        priceMinor: true,
        currency: true,
        attrs: true,
        stock: true,
        minOrder: true,
        volume: true,
        frequency: true,
        updatedAt: true,
        brand: { select: { id: true, name: true } },
        good: {
          select: {
            id: true,
            nameFa: true,
            nameEn: true,
            unit: true,
            category: { select: { slug: true, nameFa: true, nameEn: true } },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  @Put("saveListing")
  async saveListing(@Body() body: SaveListingDto, @CurrentUser() user: AuthUser, @CurrentLocale() locale: Locale) {
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);

    const good = await this.prisma.good.findUnique({
      where: { id: body.goodId },
      select: { id: true, searchText: true, nameFa: true },
    });
    if (!good) throw AppError.badRequest(t(locale, "catalog.goodNotFound", "کالای مرجع یافت نشد"), "GOOD_NOT_FOUND");

    // Spec consistency: SELL/BOTH require sell spec, BUY/BOTH require buy spec
    if (body.mode !== "BUY" && !body.sell) {
      throw AppError.badRequest(
        t(locale, "listing.sellSpecRequired", "برای فروش، مشخصات قیمت و موجودی الزامی است"),
        "SELL_SPEC_REQUIRED"
      );
    }
    if (body.mode !== "SELL" && !body.buy) {
      throw AppError.badRequest(
        t(locale, "listing.buySpecRequired", "برای خرید، حجم و تناوب الزامی است"),
        "BUY_SPEC_REQUIRED"
      );
    }

    const brandId = await this.resolveBrandId(body.brandName);
    const attrs = sanitizeAttrs(body.attrs);

    const data = {
      mode: body.mode,
      brandId, // empty input explicitly detaches the brand
      ...(attrs ? { attrs } : {}),
      ...(body.mode !== "BUY" && body.sell
        ? {
            priceMinor: body.sell.priceMinor,
            currency: business.currency, // single source of truth: the sell arm
            stock: body.sell.stock,
            minOrder: body.sell.minOrder,
          }
        : { priceMinor: null, currency: null, stock: null, minOrder: null }),
      ...(body.mode !== "SELL" && body.buy
        ? { volume: body.buy.volume, frequency: body.buy.frequency }
        : { volume: null, frequency: null }),
    };

    const existing = await this.prisma.listing.findUnique({
      where: { businessId_goodId: { businessId: business.id, goodId: body.goodId } },
      select: { id: true, priceMinor: true },
    });

    const listing = await this.prisma.listing.upsert({
      where: { businessId_goodId: { businessId: business.id, goodId: body.goodId } },
      create: { businessId: business.id, goodId: body.goodId, ...data },
      update: data,
      select: {
        id: true,
        mode: true,
        priceMinor: true,
        currency: true,
        attrs: true,
        stock: true,
        minOrder: true,
        volume: true,
        frequency: true,
        brand: { select: { id: true, name: true } },
        good: {
          select: {
            id: true,
            nameFa: true,
            nameEn: true,
            unit: true,
            category: { select: { slug: true, nameFa: true, nameEn: true } },
          },
        },
      },
    });

    if (
      existing &&
      existing.priceMinor !== null &&
      listing.priceMinor !== null &&
      existing.priceMinor !== listing.priceMinor
    ) {
      await this.prisma.priceLog.create({
        data: { listingId: listing.id, oldMinor: existing.priceMinor, newMinor: listing.priceMinor },
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
