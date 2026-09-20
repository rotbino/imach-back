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
import { MatchingService } from "./matching.service";
import {
  BusinessIdQueryDto,
  FollowSupplierDto,
  InquiriesQueryDto,
  OffersQueryDto,
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
      price: true,
      minOrder: true,
      good: { select: { id: true, name: true, category: true, unit: true } },
    },
  },
  seller: { select: { id: true, slug: true, name: true, role: true, city: true, isVerified: true } },
} as const;

const INQUIRY_INCLUDE = {
  listing: {
    select: {
      id: true,
      price: true,
      good: { select: { id: true, name: true, category: true, unit: true } },
    },
  },
  buyer: { select: { id: true, slug: true, name: true, role: true, city: true, isVerified: true } },
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
    this.cache.invalidateTag(`market:sugg:${businessId}`);
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
              price: m.price,
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
      include: { listing: { select: { minOrder: true, price: true } } },
    });
    if (!inquiry) throw AppError.notFound("Inquiry not found");
    await assertBusinessOwner(this.prisma, user, inquiry.sellerId, locale);

    const offer = await this.prisma.offer.create({
      data: {
        buyerId: inquiry.buyerId,
        sellerId: inquiry.sellerId,
        listingId: inquiry.listingId,
        price: body.price,
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

  @Get("getFollows")
  async getFollows(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    return this.prisma.follow.findMany({
      where: { buyerId: query.businessId },
      select: {
        supplierId: true,
        createdAt: true,
        supplier: { select: { slug: true, name: true, role: true, city: true, isVerified: true } },
      },
      orderBy: { createdAt: "desc" },
    });
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

    await this.prisma.follow.upsert({
      where: { buyerId_supplierId: { buyerId: business.id, supplierId: body.supplierId } },
      create: { buyerId: business.id, supplierId: body.supplierId },
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
      where: { buyerId: business.id, supplierId },
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
        const follows = await this.prisma.follow.findMany({
          where: { buyerId: query.businessId },
          select: { supplierId: true },
        });
        if (follows.length === 0) return [];

        return this.prisma.listing.findMany({
          where: {
            businessId: { in: follows.map((f) => f.supplierId) },
            mode: { in: ["SELL", "BOTH"] },
            price: { not: null },
          },
          select: {
            id: true,
            price: true,
            stock: true,
            minOrder: true,
            updatedAt: true,
            good: { select: { id: true, name: true, category: true, unit: true } },
            business: { select: { id: true, slug: true, name: true, role: true, city: true, isVerified: true } },
            priceLogs: { orderBy: { createdAt: "desc" }, take: 1, select: { oldPrice: true, newPrice: true, createdAt: true } },
          },
          orderBy: { updatedAt: "desc" },
          take: 200,
        });
      }
    );

    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  }

  /** Suggested buyers for my sell catalog (sell-arm widget). */
  @Get("getSuggestions")
  async getSuggestions(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    const { value, hit } = await this.cache.wrap(
      `market:sugg:${query.businessId}`,
      { ttlMs: TTL.MINUTE, tags: [`market:sugg:${query.businessId}`] },
      () => this.matching.buyersForSeller(business.id, business.city)
    );

    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  }
}
