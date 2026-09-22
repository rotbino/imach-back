import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CacheService, TTL } from "../common/cache/cache.module";
import { CurrentLocale, CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import type { Locale } from "../common/i18n/i18n";
import { assertBusinessOwner } from "../common/guards";
import { cursorBefore, decodeCursor, toPage } from "../common/pagination/cursor";
import { PrismaService } from "../common/prisma/prisma.module";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ensurePage } from "../common/pages";
import { MatchingService } from "./matching.service";
import {
  BusinessIdQueryDto,
  FollowSupplierDto,
  InquiriesQueryDto,
  OffersQueryDto,
  RemoveFollowerDto,
  RequestQuoteDto,
  SendOfferDto,
  UnfollowSupplierDto,
} from "./dto/market.dto";

/** ObjectId hex guard — keeps invalid params away from Prisma. */
const isObjectId = (v: string | undefined): v is string => /^[a-f\d]{24}$/i.test(v ?? "");

const OFFER_INCLUDE = {
  listing: {
    select: {
      id: true,
      priceMinor: true,
      currency: true,
      minOrder: true,
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
  },
  seller: { select: { id: true, slug: true, name: true, city: true, isVerified: true } },
} as const;

const INQUIRY_INCLUDE = {
  listing: {
    select: {
      id: true,
      priceMinor: true,
      currency: true,
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
  },
  buyer: { select: { id: true, slug: true, name: true, city: true, isVerified: true } },
} as const;

/** The whole market module is authenticated — buyers and sellers only. */
@Controller("market")
@UseGuards(JwtAuthGuard)
export class MarketController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly matching: MatchingService
  ) {}

  private invalidateBuyerSide(businessId: string): void {
    this.cache.invalidateTag(`market:board:${businessId}`);
    this.cache.invalidateTag(`market:ssugg:${businessId}`);
    this.cache.invalidateTag(`market:buyreq:${businessId}`);
  }

  /**
   * The core loop: buyer hits "درخواست قیمت" on a BUY listing.
   * The engine ranks suppliers, creates an Inquiry for each matched seller
   * and a persisted Offer for the buyer — atomically in one transaction.
   */
  @Post("requestQuote/:id")
  @HttpCode(201)
  async requestQuote(
    @Param("id") listingId: string,
    @Body() body: RequestQuoteDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    if (!isObjectId(listingId)) throw AppError.notFound("Listing not found");
    return this.requestQuoteImpl(listingId, body, user, locale);
  }

  private async requestQuoteImpl(
    listingId: string,
    body: RequestQuoteDto,
    user: AuthUser,
    locale: Locale
  ) {
    const need = await this.prisma.listing.findUnique({ where: { id: listingId }, include: { good: true } });
    if (!need) throw AppError.notFound("Listing not found");
    const business = await assertBusinessOwner(this.prisma, user, need.businessId, locale);

    if (need.mode === "SELL" || need.volume === null) {
      throw AppError.badRequest("استعلام قیمت فقط برای کالاهای خرید قابل انجام است", "NOT_A_BUY_LISTING");
    }

    const matches = await this.matching.suppliersForNeed(
      business.id,
      business.city,
      need.goodId,
      need.volume
    );
    if (matches.length === 0) return { created: 0, offers: [] };

    const created = await this.prisma.$transaction(async (tx) => {
      const offers = [];
      for (const m of matches) {
        await tx.inquiry.create({
          data: {
            buyerId: business.id,
            sellerId: m.sellerId,
            listingId: m.listingId,
            volume: need.volume as number,
            note: body.note?.trim() || null,
          },
        });
        offers.push(
          await tx.offer.create({
            data: {
              buyerId: business.id,
              sellerId: m.sellerId,
              listingId: m.listingId,
              priceMinor: m.priceMinor,
              currency: m.currency ?? "IRR",
              minOrder: m.minOrder,
              score: m.score,
              isSpecial: m.isSpecial,
              note: body.note?.trim() || null,
            },
            include: OFFER_INCLUDE,
          })
        );
      }
      return offers;
    });

    this.invalidateBuyerSide(business.id);
    return { created: created.length, offers: created };
  }

  /** Offers received by a buyer (per business), newest first, cursor-paginated. */
  @Get("getOffers")
  async getOffers(
    @Query() query: OffersQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    const cap = Math.min(query.limit ?? 50, 100);
    const rows = await this.prisma.offer.findMany({
      where: { buyerId: query.businessId, ...cursorBefore(decodeCursor(query.cursor)) },
      include: OFFER_INCLUDE,
      orderBy: { id: "desc" },
      take: cap + 1,
    });
    return toPage(rows, cap);
  }

  /** Seller answers an inquiry with a concrete price → becomes an Offer for the buyer. */
  @Post("sendOffer")
  async sendOffer(
    @Body() body: SendOfferDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    if (!isObjectId(body.inquiryId)) throw AppError.notFound("Inquiry not found");
    const inquiry = await this.prisma.inquiry.findUnique({
      where: { id: body.inquiryId },
      include: { listing: { select: { minOrder: true, priceMinor: true, currency: true } } },
    });
    if (!inquiry) throw AppError.notFound("Inquiry not found");
    await assertBusinessOwner(this.prisma, user, inquiry.sellerId, locale);

    const offer = await this.prisma.offer.create({
      data: {
        buyerId: inquiry.buyerId,
        sellerId: inquiry.sellerId,
        listingId: inquiry.listingId,
        priceMinor: body.priceMinor,
        currency: inquiry.listing.currency ?? "IRR",
        minOrder: inquiry.listing.minOrder ?? 0,
        score: 0, // manual answer — no engine score
        isSpecial: false,
        note: body.note?.trim() || null,
      },
      include: OFFER_INCLUDE,
    });

    await this.prisma.inquiry.update({
      where: { id: inquiry.id },
      data: { status: "ANSWERED", isRead: true },
    });

    this.invalidateBuyerSide(inquiry.buyerId);
    this.cache.invalidateTag(`market:inq:${inquiry.sellerId}`);
    return offer;
  }

  /** Inquiries received by a seller. */
  @Get("getInquiries")
  async getInquiries(
    @Query() query: InquiriesQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    const cap = Math.min(query.limit ?? 30, 100);
    const [rows, unread] = await Promise.all([
      this.prisma.inquiry.findMany({
        where: { sellerId: query.businessId, ...cursorBefore(decodeCursor(query.cursor)) },
        include: INQUIRY_INCLUDE,
        orderBy: { id: "desc" },
        take: cap + 1,
      }),
      this.prisma.inquiry.count({ where: { sellerId: query.businessId, isRead: false } }),
    ]);
    return { ...toPage(rows, cap), unreadCount: unread };
  }

  @Post("markInquiryRead/:id")
  async markInquiryRead(
    @Param("id") inquiryId: string,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    if (!isObjectId(inquiryId)) throw AppError.notFound("Inquiry not found");
    const inquiry = await this.prisma.inquiry.findUnique({
      where: { id: inquiryId },
      select: { id: true, sellerId: true },
    });
    if (!inquiry) throw AppError.notFound("Inquiry not found");
    await assertBusinessOwner(this.prisma, user, inquiry.sellerId, locale);
    await this.prisma.inquiry.update({ where: { id: inquiry.id }, data: { isRead: true } });
    this.cache.invalidateTag(`market:inq:${inquiry.sellerId}`);
    return { ok: true };
  }

  /** The supplier catalogs my BUY page tracks (price-tracking subscriptions). */
  @Get("getFollows")
  async getFollows(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    const pageId = await ensurePage(this.prisma, query.businessId, "BUY");
    const rows = await this.prisma.follow.findMany({
      where: { followerPageId: pageId },
      select: {
        createdAt: true,
        viaRef: true,
        supplierPage: {
          select: { business: { select: { id: true, slug: true, name: true, city: true, isVerified: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => ({
      supplierId: r.supplierPage.business.id,
      createdAt: r.createdAt,
      viaRef: r.viaRef,
      supplier: {
        slug: r.supplierPage.business.slug,
        name: r.supplierPage.business.name,
        city: r.supplierPage.business.city,
        isVerified: r.supplierPage.business.isVerified,
      },
    }));
  }

  @Post("followSupplier")
  async followSupplier(
    @Body() body: FollowSupplierDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    if (body.supplierId === business.id) {
      throw AppError.badRequest("نمی‌توانید کسب‌وکار خودتان را فالو کنید", "SELF_FOLLOW");
    }
    const supplier = await this.prisma.business.findUnique({
      where: { id: body.supplierId },
      select: { id: true },
    });
    if (!supplier) throw AppError.notFound("Supplier not found");

    const followerPageId = await ensurePage(this.prisma, business.id, "BUY");
    const supplierPageId = await ensurePage(this.prisma, body.supplierId, "SELL");
    await this.prisma.follow.upsert({
      where: { followerPageId_supplierPageId: { followerPageId, supplierPageId } },
      create: { followerPageId, supplierPageId },
      update: {},
    });
    this.invalidateBuyerSide(business.id);
    return { ok: true };
  }

  @Post("unfollowSupplier/:supplierId")
  async unfollowSupplier(
    @Param("supplierId") supplierId: string,
    @Body() body: UnfollowSupplierDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    await this.prisma.follow.deleteMany({
      where: {
        followerPage: { businessId: business.id, type: "BUY" },
        supplierPage: { businessId: supplierId },
      },
    });
    this.invalidateBuyerSide(business.id);
    return { ok: true };
  }

  /**
   * Live price board: latest sell listing of every followed supplier with
   * the most recent PriceLog for trend detection. Short TTL — "live" by design.
   */
  @Get("getPriceBoard")
  async getPriceBoard(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    const { value, hit } = await this.cache.wrap(
      `market:board:${query.businessId}`,
      { ttlMs: TTL.SHORT, tags: [`market:board:${query.businessId}`] },
      async () => {
        const pageId = await ensurePage(this.prisma, query.businessId, "BUY");
        const follows = await this.prisma.follow.findMany({
          where: { followerPageId: pageId },
          select: { supplierPage: { select: { businessId: true } } },
        });
        const supplierIds = follows.map((f) => f.supplierPage.businessId);
        if (supplierIds.length === 0) return [];

        return this.prisma.listing.findMany({
          where: {
            businessId: { in: supplierIds },
            mode: { in: ["SELL", "BOTH"] },
            priceMinor: { not: null },
          },
          select: {
            id: true,
            priceMinor: true,
            currency: true,
            stock: true,
            minOrder: true,
            updatedAt: true,
            good: {
              select: {
                id: true,
                nameFa: true,
                nameEn: true,
                unit: true,
                category: { select: { slug: true, nameFa: true, nameEn: true } },
              },
            },
            business: { select: { id: true, slug: true, name: true, city: true, isVerified: true } },
            priceLogs: { orderBy: { createdAt: "desc" }, take: 1, select: { oldMinor: true, newMinor: true, createdAt: true } },
          },
          orderBy: { updatedAt: "desc" },
          take: 200,
        });
      }
    );

    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  }

  /** Suggested suppliers for my buy needs — the buy-side follow engine. */
  @Get("getSupplierSuggestions")
  async getSupplierSuggestions(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    const { value, hit } = await this.cache.wrap(
      `market:ssugg:${query.businessId}`,
      { ttlMs: TTL.MINUTE, tags: [`market:ssugg:${query.businessId}`] },
      () => this.matching.suppliersForBuyer(business.id, business.city)
    );

    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  }

  /**
   * مشتریان من — buyers who track my catalog, enriched for the customers
   * page: each row carries the follower's identity, whether it arrived via
   * the owner's referral link, and its latest active buy request. Customers
   * with an active request bubble to the top (recency first), so a new
   * request literally surfaces the customer at the top of the list.
   */
  @Get("getFollowers")
  async getFollowers(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    const pageId = await ensurePage(this.prisma, query.businessId, "SELL");
    const rows = await this.prisma.follow.findMany({
      where: { supplierPageId: pageId },
      select: {
        createdAt: true,
        viaRef: true,
        followerPage: {
          select: {
            business: {
              select: {
                id: true,
                slug: true,
                name: true,
                city: true,
                isVerified: true,
                listings: {
                  where: { mode: { in: ["BUY", "BOTH"] }, volume: { not: null } },
                  orderBy: { updatedAt: "desc" },
                  take: 1,
                  select: {
                    volume: true,
                    frequency: true,
                    updatedAt: true,
                    good: { select: { nameFa: true, nameEn: true, unit: true } },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    const mapped = rows.map((r) => ({
      id: r.followerPage.business.id,
      slug: r.followerPage.business.slug,
      name: r.followerPage.business.name,
      city: r.followerPage.business.city,
      isVerified: r.followerPage.business.isVerified,
      followedAt: r.createdAt,
      viaRef: r.viaRef,
      latestRequest: r.followerPage.business.listings[0] ?? null,
    }));

    // active-request customers first (newest request wins), then the rest
    // in follow order
    return mapped.sort((a, b) => {
      const ra = a.latestRequest?.updatedAt?.getTime() ?? 0;
      const rb = b.latestRequest?.updatedAt?.getTime() ?? 0;
      if ((ra > 0) !== (rb > 0)) return rb > 0 ? 1 : -1;
      if (ra && rb && ra !== rb) return rb - ra;
      return b.followedAt.getTime() - a.followedAt.getTime();
    });
  }

  /**
   * حذف فالوور از لیست مشتریان — the catalog owner curates their customer
   * list: valueless follows (competitors window-shopping prices, accidental
   * signups) can be removed. The removed buyer may re-follow anytime.
   */
  @Post("removeFollower")
  async removeFollower(
    @Body() body: RemoveFollowerDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    const removed = await this.prisma.follow.deleteMany({
      where: {
        supplierPage: { businessId: business.id, type: "SELL" },
        followerPage: { businessId: body.followerBusinessId, type: "BUY" },
      },
    });
    return { ok: true, removed: removed.count };
  }

  /**
   * Buy-requests list — the most RELEVANT requests for the current user
   * (goods they sell with volume fit, or goods they buy from same-level
   * peers). The ranking lives in the matching engine — the API just serves it.
   */
  @Get("getBuyRequests")
  async getBuyRequests(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    const { value, hit } = await this.cache.wrap(
      `market:buyreq:${query.businessId}`,
      { ttlMs: TTL.MINUTE, tags: [`market:buyreq:${query.businessId}`] },
      () => this.matching.buyRequestsFor(business.id, business.city)
    );
    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  }
}
