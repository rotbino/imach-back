import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CacheService, TTL } from "../common/cache/cache.module";
import { env } from "../common/config/env";
import { CurrentLocale, CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import type { Locale } from "../common/i18n/i18n";
import { assertBusinessOwner } from "../common/guards";
import { cursorBefore, decodeCursor, toPage } from "../common/pagination/cursor";
import { PrismaService } from "../common/prisma/prisma.module";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ensurePage } from "../common/pages";
import { NotificationsService } from "../notifications/notifications.service";
import { MatchingService } from "./matching.service";
import {
  BusinessIdQueryDto,
  FollowBuyerDto,
  FollowSupplierDto,
  InquiriesQueryDto,
  OffersQueryDto,
  OfferBuyRequestDto,
  RemoveFollowerDto,
  RequestQuoteDto,
  SendOfferDto,
  SupplyBoardQueryDto,
  UnfollowSupplierDto,
  UnwatchGoodDto,
  WatchGoodDto,
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
      /** فاز ۴ — برچسب واریانت برای کارت «مطابق کاتالوگ شما» (طرح ۰۶) */
      variantLabel: true,
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
  buyer: {
    select: {
      id: true,
      slug: true,
      name: true,
      city: true,
      isVerified: true,
      /** فاز ۴ — صنف و تماس خریدار برای صفحه جزئیات درخواست (طرح ۰۶) */
      trade: true,
      activityType: true,
      phone: true,
    },
  },
} as const;

/** The whole market module is authenticated — buyers and sellers only. */
@Controller("market")
@UseGuards(JwtAuthGuard)
export class MarketController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly matching: MatchingService,
    private readonly notifications: NotificationsService
  ) {}

  private invalidateBuyerSide(businessId: string): void {
    this.cache.invalidateTag(`market:board:${businessId}`);
    this.cache.invalidateTag(`market:ssugg:${businessId}`);
    this.cache.invalidateTag(`market:buyreq:${businessId}`);
  }

  /** Members this owner personally brought in via referral links — the growth currency. */
  private referralCountOf(ownerId: string | null): Promise<number> {
    return this.prisma.user.count({ where: { referredById: ownerId ?? "__none__" } });
  }

  /**
   * The referral gate — buyer-follow and cold-offer stay locked until the
   * seller has brought REFERRAL_TARGET members through their catalog link.
   * 403 + REFERRAL_GATE; the UI renders the progress strip itself.
   */
  private async assertReferralUnlocked(
    business: { ownerId: string | null },
    locale: Locale
  ): Promise<void> {
    const count = await this.referralCountOf(business.ownerId);
    if (count >= env.REFERRAL_TARGET) return;
    throw new AppError(
      "REFERRAL_GATE",
      `برای فعال شدن این امکان، ${env.REFERRAL_TARGET} عضو با لینک کاتالوگتان بیاورید`,
      HttpStatus.FORBIDDEN,
      { count, required: env.REFERRAL_TARGET }
    );
  }

  /**
   * وضعیت گیت رشد برای بازار خریدارها (بازوی فروش) — یک فراخوان برای همه‌ی
   * عناصر صفحه: شمارنده‌ی معرف، کالاهای فروشی (گیت کاتالوگ خالی)، و فالو/
   * پیشنهادهای قبلی من روی خریدارها.
   */
  @Get("getMarketState")
  async getMarketState(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    const [count, sellListings, buyerEdges, myOffers] = await Promise.all([
      this.referralCountOf(business.ownerId),
      this.prisma.listing.findMany({
        where: { businessId: business.id, isActive: true, mode: { in: ["SELL", "BOTH"] } },
        select: { goodId: true },
      }),
      this.prisma.follow.findMany({
        where: {
          followerPage: { businessId: business.id, type: "SELL" },
          supplierPage: { type: "BUY" },
        },
        select: { supplierPage: { select: { businessId: true } } },
      }),
      this.prisma.offer.findMany({
        where: { sellerId: business.id },
        select: { buyerId: true },
        distinct: ["buyerId"],
      }),
    ]);
    const required = env.REFERRAL_TARGET;
    return {
      referral: { count, required, unlocked: count >= required },
      sellCount: sellListings.length,
      sellGoodIds: [...new Set(sellListings.map((l) => l.goodId))],
      followedBuyerIds: buyerEdges.map((e) => e.supplierPage.businessId),
      offeredBuyerIds: myOffers.map((o) => o.buyerId),
      currency: business.currency,
    };
  }

  /**
   * POST /market/requestQuote — فرم درخواست قیمت (فاز ۶ · طرح ۱۲ · شکاف ۴).
   * جایگزین جریان خودکارِ قدیمی (requestQuote/:listingId): گیرندگان این‌جا
   * از تابلوی تأمین «انتخابی»‌اند + گزینه گسترش به شبکه iMach (موتور تطبیق،
   * حداکثر ۵ گیرنده در کل). Inquiry روی آگهیِ فروشِ همان تأمین‌کننده می‌نشیند —
   * پیشنهادِ قیمت را خودِ فروشنده بعداً با sendOffer می‌فرستد (پاسخ واقعی،
   * نه پاسخِ آنیِ موتور). پاسخ‌ها در «درخواست‌های من» خریدار می‌نشینند.
   */
  @Post("requestQuote")
  @HttpCode(HttpStatus.CREATED)
  async requestQuote(
    @Body() body: RequestQuoteDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    const good = await this.prisma.good.findUnique({
      where: { id: body.goodId },
      select: { id: true, nameFa: true },
    });
    if (!good) throw AppError.notFound("Good not found");

    const hasSelection = (body.supplierIds?.length ?? 0) > 0;
    if (!hasSelection && !body.includeNetwork) {
      throw AppError.badRequest("حداقل یک تأمین‌کننده انتخاب کنید یا شبکه iMach را روشن کنید", "NO_RECIPIENT");
    }

    // رزولوشن گیرندگان: sellerId → آگهیِ فروشِ فعالِ همان کالا (ردیف تابلو)
    const CAP = 5;
    const targets = new Map<string, string>(); // sellerBusinessId → listingId
    if (hasSelection) {
      const rows = await this.prisma.listing.findMany({
        where: {
          goodId: good.id,
          isActive: true,
          mode: { in: ["SELL", "BOTH"] },
          businessId: { in: [...new Set(body.supplierIds as string[])].filter((id) => id !== business.id) },
        },
        select: { id: true, businessId: true },
        orderBy: { priceMinor: "asc" },
      });
      for (const r of rows) if (!targets.has(r.businessId)) targets.set(r.businessId, r.id);
    }

    // گسترش به شبکه iMach — بقیه ظرفیت با موتور تطبیق (امتیاز + جغرافیا)
    if (body.includeNetwork && targets.size < CAP) {
      const matches = await this.matching.suppliersForNeed(
        business.id,
        { city: business.city, province: business.province, country: business.country },
        good.id,
        body.volume,
        CAP
      );
      for (const m of matches) {
        if (targets.size >= CAP) break;
        if (!targets.has(m.sellerId)) targets.set(m.sellerId, m.listingId);
      }
    }

    if (targets.size === 0) return { created: 0, networkAdded: 0, inquiries: [] };

    const note = body.note?.trim() || null;
    const created = await this.prisma.$transaction(async (tx) => {
      const inquiries = [];
      for (const [sellerId, listingId] of targets) {
        inquiries.push(
          await tx.inquiry.create({
            data: {
              buyerId: business.id,
              sellerId,
              listingId,
              volume: body.volume,
              note,
              frequency: body.frequency ?? null,
              delivery: body.delivery?.trim() || null,
            },
          })
        );
      }
      return inquiries;
    });

    this.invalidateBuyerSide(business.id);

    // درخواست به هر فروشنده رسید — هر مالک یک اعلان (dedupe با pushMany)
    const sellers = await this.prisma.business.findMany({
      where: { id: { in: [...targets.keys()] }, ownerId: { not: null } },
      select: { id: true, ownerId: true },
    });
    await this.notifications.pushMany(
      sellers.map((s) => ({
        userId: s.ownerId as string,
        type: "QUOTE" as const,
        actorId: business.id,
        actorName: business.name,
        actorSlug: business.slug,
        good: good.nameFa,
      }))
    );

    const selectedSet = new Set(body.supplierIds ?? []);
    return {
      created: created.length,
      networkAdded: created.filter((i) => !selectedSet.has(i.sellerId)).length,
      inquiries: created.map((i) => ({ id: i.id, sellerId: i.sellerId, status: i.status })),
    };
  }

  /**
   * GET /market/getSupplyBoard — تابلوی تأمین یک کالا (فاز ۶ · طرح ۰۹ · شکاف ۵).
   * ردیف = هر آگهیِ فروشِ فعالِ همان کالا (به‌جز خودم): قیمت/روند از آخرین
   * PriceLog، تازگی از updatedAt، ظرفیت از stock/minOrder + برچسب رابطه:
   *   followedByMe → «دنبال می‌کنم» (فالوی کاتالوگِ او از میز خرید من)
   *   boughtFrom   → «از او خریده‌ام» (سابقه Inquiry بین دو کسب‌وکار در همین کالا)
   *   sponsored    → «معرفی iMach» (فعلاً خالی — فقط ساختار UI، طرح ۰۹)
   * به‌علاوه زمینه‌ی خریدار: watched + حجم/دوره‌ی BUY listing خودش (پیش‌فرض فرم ۱۲).
   */
  @Get("getSupplyBoard")
  async getSupplyBoard(
    @Query() query: SupplyBoardQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    const good = await this.prisma.good.findUnique({
      where: { id: query.goodId },
      select: {
        id: true, nameFa: true, nameEn: true, unit: true,
        category: { select: { slug: true, nameFa: true, nameEn: true } },
      },
    });
    if (!good) throw AppError.notFound("Good not found");

    const listings = await this.prisma.listing.findMany({
      where: {
        goodId: good.id,
        isActive: true,
        mode: { in: ["SELL", "BOTH"] },
        priceMinor: { not: null },
        businessId: { not: business.id },
      },
      select: {
        id: true, priceMinor: true, currency: true, minOrder: true, stock: true,
        variantLabel: true, updatedAt: true,
        business: { select: { id: true, slug: true, name: true, city: true, isVerified: true, trade: true } },
        priceLogs: { orderBy: { createdAt: "desc" }, take: 1, select: { oldMinor: true, newMinor: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });

    const [followedPages, myInquirySellers, watch, myBuy] = await Promise.all([
      // «دنبال می‌کنم» — فالوی کاتالوگِ فروشنده از میز خرید من
      this.prisma.follow.findMany({
        where: {
          followerPage: { businessId: business.id, type: "BUY" },
          supplierPage: { businessId: { in: listings.map((l) => l.business.id) }, type: "SELL" },
        },
        select: { supplierPage: { select: { businessId: true } } },
      }),
      // «از او خریده‌ام» — سابقه استعلام بین من و او روی همین کالا
      this.prisma.inquiry.findMany({
        where: {
          buyerId: business.id,
          sellerId: { in: listings.map((l) => l.business.id) },
          listing: { goodId: good.id },
        },
        select: { sellerId: true },
        take: 200,
      }),
      this.prisma.watchedGood.findUnique({
        where: { businessId_goodId: { businessId: business.id, goodId: good.id } },
        select: { id: true },
      }),
      this.prisma.listing.findFirst({
        where: { businessId: business.id, goodId: good.id, mode: { in: ["BUY", "BOTH"] }, isActive: true },
        select: { volume: true, frequency: true, variantLabel: true },
      }),
    ]);

    const followedSet = new Set(followedPages.map((f) => f.supplierPage.businessId));
    const boughtSet = new Set(myInquirySellers.map((i) => i.sellerId));

    return {
      good,
      watched: watch !== null,
      volume: myBuy?.volume ?? null,
      frequency: myBuy?.frequency ?? null,
      variantLabel: myBuy?.variantLabel ?? null,
      rows: listings.map((l) => {
        const log = l.priceLogs[0];
        return {
          listingId: l.id,
          priceMinor: l.priceMinor as number,
          currency: l.currency,
          minOrder: l.minOrder,
          stock: l.stock,
          variantLabel: l.variantLabel,
          updatedAt: l.updatedAt,
          seller: l.business,
          prevMinor: log?.oldMinor ?? null,
          trendPct:
            log && log.oldMinor > 0
              ? Math.round((((l.priceMinor as number) - log.oldMinor) / log.oldMinor) * 100)
              : null,
          followedByMe: followedSet.has(l.business.id),
          boughtFrom: boughtSet.has(l.business.id),
          sponsored: false, // فلگ آینده — فعلاً خالی (طرح ۰۹: فقط ساختار UI)
        };
      }),
    };
  }

  /**
   * فالو کردن یک خریدار از بازار خریدارها — «می‌خواهم تامین‌کننده‌اش باشم».
   * قرینه‌ی followSupplier: صفحه‌ی SELL من صفحه‌ی BUY خریدار را دنبال می‌کند و
   * در «تامین من» او با برچسب می‌نشیند.
   * رایگان (خواسته‌ی کاربر): سمت تقاضا گیت ندارد — فالو و تماس آزاد؛
   * گیت ۱۰ معرف فقط روی «ارسال پیشنهاد» مانده است.
   */
  @Post("followBuyer")
  async followBuyer(
    @Body() body: FollowBuyerDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    if (body.buyerBusinessId === business.id) {
      throw AppError.badRequest("نمی‌توانید کسب‌وکار خودتان را فالو کنید", "SELF_FOLLOW");
    }
    const buyer = await this.prisma.business.findUnique({
      where: { id: body.buyerBusinessId },
      select: { id: true, ownerId: true },
    });
    if (!buyer) throw AppError.notFound("Buyer not found");

    const followerPageId = await ensurePage(this.prisma, business.id, "SELL");
    const buyerPageId = await ensurePage(this.prisma, body.buyerBusinessId, "BUY");
    const existed = await this.prisma.follow.findUnique({
      where: { followerPageId_supplierPageId: { followerPageId, supplierPageId: buyerPageId } },
      select: { id: true },
    });
    await this.prisma.follow.upsert({
      where: { followerPageId_supplierPageId: { followerPageId, supplierPageId: buyerPageId } },
      create: { followerPageId, supplierPageId: buyerPageId },
      update: {},
    });
    // فقط فالوی تازه اعلان دارد — تکرار ساکت می‌ماند
    if (!existed && buyer.ownerId) {
      await this.notifications.push({
        userId: buyer.ownerId,
        type: "FOLLOW_BUYER",
        actorId: business.id,
        actorName: business.name,
        actorSlug: business.slug,
      });
    }
    this.invalidateBuyerSide(body.buyerBusinessId);
    return { ok: true };
  }

  /** برداشتن فالوی خریدار — ترک کردن همیشه آزاد است (گیت فقط برای ورود است). */
  @Post("unfollowBuyer/:buyerId")
  async unfollowBuyer(
    @Param("buyerId") buyerId: string,
    @Body() body: UnfollowSupplierDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    await this.prisma.follow.deleteMany({
      where: {
        followerPage: { businessId: business.id, type: "SELL" },
        supplierPage: { businessId: buyerId, type: "BUY" },
      },
    });
    this.invalidateBuyerSide(buyerId);
    return { ok: true };
  }

  /**
   * پیشنهاد قیمت مستقیم روی یک درخواست خرید (بازار خریدارها) — پشت گیت ۱۰
   * معرف. پیشنهاد یک Offer واقعی روی لیستینگِ همان کالا در کاتالوگ فروش من
   * است، پس در جریان «پیشنهادهای دریافتی» خریدار بدون هیچ جریان جدیدی می‌افتد.
   */
  @Post("offerBuyRequest")
  @HttpCode(201)
  async offerBuyRequest(
    @Body() body: OfferBuyRequestDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    if (!isObjectId(body.buyListingId)) throw AppError.notFound("Listing not found");
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    await this.assertReferralUnlocked(business, locale);

    const need = await this.prisma.listing.findUnique({
      where: { id: body.buyListingId },
      select: {
        id: true,
        businessId: true,
        mode: true,
        volume: true,
        goodId: true,
        isActive: true,
        good: { select: { nameFa: true } },
      },
    });
    if (!need || need.isActive === false || need.mode === "SELL" || need.volume === null) {
      throw AppError.badRequest("این یک درخواست خرید فعال نیست", "NOT_A_BUY_LISTING");
    }
    if (need.businessId === business.id) {
      throw AppError.badRequest("نمی‌توانید به درخواست خودتان پیشنهاد بدهید", "SELF_OFFER");
    }

    const myList = await this.prisma.listing.findFirst({
      where: { businessId: business.id, goodId: need.goodId, isActive: true, mode: { in: ["SELL", "BOTH"] } },
      orderBy: { updatedAt: "desc" },
      select: { id: true, currency: true, minOrder: true },
    });
    if (!myList) {
      throw AppError.badRequest("این کالا در کاتالوگ فروش شما نیست", "RELATED_LISTING_MISSING");
    }

    const offer = await this.prisma.offer.create({
      data: {
        buyerId: need.businessId,
        sellerId: business.id,
        listingId: myList.id,
        priceMinor: body.priceMinor,
        currency: myList.currency ?? business.currency ?? "IRR",
        minOrder: myList.minOrder ?? 0,
        score: 0, // پیشنهاد مستقیم — بدون امتیاز موتور
        isSpecial: false,
        note: body.note?.trim() || null,
      },
      include: OFFER_INCLUDE,
    });

    // خریدار باید بداند پیشنهاد تازه نشسته — فوراً، نه دفعه‌ی بعد که پنل را باز کرد
    const buyerOwner = await this.prisma.business.findUnique({
      where: { id: need.businessId },
      select: { ownerId: true },
    });
    if (buyerOwner?.ownerId) {
      await this.notifications.push({
        userId: buyerOwner.ownerId,
        type: "OFFER",
        actorId: business.id,
        actorName: business.name,
        actorSlug: business.slug,
        good: need.good.nameFa,
      });
    }

    this.invalidateBuyerSide(need.businessId);
    return offer;
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
      include: {
        listing: {
          select: { minOrder: true, priceMinor: true, currency: true, good: { select: { nameFa: true } } },
        },
      },
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

    // پاسخ قیمت تازه روی استعلام خریدار — اعلان فوری
    const parties = await this.prisma.business.findMany({
      where: { id: { in: [inquiry.buyerId, inquiry.sellerId] } },
      select: { id: true, ownerId: true, name: true, slug: true },
    });
    const buyerBiz = parties.find((b) => b.id === inquiry.buyerId);
    const sellerBiz = parties.find((b) => b.id === inquiry.sellerId);
    if (buyerBiz?.ownerId) {
      await this.notifications.push({
        userId: buyerBiz.ownerId,
        type: "OFFER",
        actorId: sellerBiz?.id ?? inquiry.sellerId,
        actorName: sellerBiz?.name ?? null,
        actorSlug: sellerBiz?.slug ?? null,
        good: inquiry.listing.good.nameFa,
      });
    }

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

  /** فاز ۴ (طرح ۰۶) — فروشنده درخواست را از صندوق ورودی بیرون می‌گذارد.
   *  آرشیو = فقط وضعیت؛ تاریخچه و پیشنهادهای قبلی دست‌نخورده می‌مانند. */
  @Post("archiveInquiry/:id")
  async archiveInquiry(
    @Param("id") inquiryId: string,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    if (!isObjectId(inquiryId)) throw AppError.notFound("Inquiry not found");
    const inquiry = await this.prisma.inquiry.findUnique({
      where: { id: inquiryId },
      select: { id: true, sellerId: true, status: true },
    });
    if (!inquiry) throw AppError.notFound("Inquiry not found");
    await assertBusinessOwner(this.prisma, user, inquiry.sellerId, locale);
    await this.prisma.inquiry.update({
      where: { id: inquiry.id },
      data: { status: "ARCHIVED", isRead: true },
    });
    this.cache.invalidateTag(`market:inq:${inquiry.sellerId}`);
    return { ok: true };
  }

  // ═══ فاز ۵ — دنبال‌کردن قیمت (شکاف ۱) و لیست خرید (طرح ۰۸) ═══

  /** «دنبال کردن قیمت» — خریدار کالا را در لیست/تابلوی خودش می‌نشاند.
   *  آیدی‌پاتنت: upsert؛ دنبال‌کردنِ دوباره بی‌ضرر است. */
  @Post("watchGood")
  @HttpCode(HttpStatus.CREATED)
  async watchGood(
    @Body() body: WatchGoodDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    if (!isObjectId(body.goodId)) throw AppError.notFound("Good not found");
    await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    const good = await this.prisma.good.findUnique({ where: { id: body.goodId }, select: { id: true } });
    if (!good) throw AppError.notFound("Good not found");
    const wg = await this.prisma.watchedGood.upsert({
      where: { businessId_goodId: { businessId: body.businessId, goodId: body.goodId } },
      create: { businessId: body.businessId, goodId: body.goodId },
      update: {},
    });
    this.cache.invalidateTag(`market:watch:${body.businessId}`);
    return { ok: true, watched: true, id: wg.id };
  }

  /** حذف از لیست خرید — «دنبال نکردن»؛ BUY listing مالک دست‌نخورده می‌ماند. */
  @Post("unwatchGood/:goodId")
  async unwatchGood(
    @Param("goodId") goodId: string,
    @Body() body: UnwatchGoodDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    if (!isObjectId(goodId)) throw AppError.notFound("Good not found");
    await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    await this.prisma.watchedGood.deleteMany({ where: { businessId: body.businessId, goodId } });
    this.cache.invalidateTag(`market:watch:${body.businessId}`);
    return { ok: true, watched: false };
  }

  /**
   * لیست خرید (طرح ۰۸) — ردیف‌ها = WatchedGoodها + BUY listingهای موجود،
   * ادغام‌شده بر حسب کالا (مهاجرت کم‌ریسک: BUY listing منبع حجم/دوره می‌ماند).
   * هر ردیف خلاصه‌ی تابلوی تأمین همان کالا را دارد: تعداد تامین‌کننده‌ی فعال،
   * ارزان‌ترین قیمت + فروشنده‌اش، روند هفتگی (PriceLog) و پرچم «تغییر قیمت».
   * فروشنده‌های خودِ خریدار هرگز در تابلوی خودش نمی‌نشینند.
   */
  @Get("getWatchedGoods")
  async getWatchedGoods(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    await assertBusinessOwner(this.prisma, user, query.businessId, locale);

    const [buyListings, watched] = await Promise.all([
      this.prisma.listing.findMany({
        where: { businessId: query.businessId, mode: { in: ["BUY", "BOTH"] }, isActive: true },
        select: { id: true, goodId: true, volume: true, frequency: true, variantLabel: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.watchedGood.findMany({
        where: { businessId: query.businessId },
        select: { goodId: true, createdAt: true, lastNotifiedAt: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const goodIds = [...new Set([...buyListings.map((l) => l.goodId), ...watched.map((w) => w.goodId)])];
    if (goodIds.length === 0) return [];

    const [goods, supply, logs] = await Promise.all([
      this.prisma.good.findMany({
        where: { id: { in: goodIds } },
        select: {
          id: true, nameFa: true, nameEn: true, unit: true,
          category: { select: { slug: true, nameFa: true, nameEn: true } },
        },
      }),
      this.prisma.listing.findMany({
        where: {
          goodId: { in: goodIds },
          businessId: { not: query.businessId },
          isActive: true,
          mode: { in: ["SELL", "BOTH"] },
          priceMinor: { not: null },
        },
        select: {
          id: true, goodId: true, priceMinor: true, currency: true,
          variantLabel: true, minOrder: true,
          business: { select: { id: true, slug: true, name: true, city: true, isVerified: true } },
        },
      }),
      // تغییرات قیمتِ ۷ روز اخیرِ همان تابلوها — سوختِ روند و چیپ «تغییر قیمت»
      this.prisma.priceLog.findMany({
        where: {
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) },
          listing: {
            goodId: { in: goodIds },
            isActive: true,
            businessId: { not: query.businessId },
            mode: { in: ["SELL", "BOTH"] },
          },
        },
        select: { listingId: true, oldMinor: true, newMinor: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    const goodById = new Map(goods.map((g) => [g.id, g]));
    const supplyByGood = new Map<string, typeof supply>();
    for (const s of supply) {
      const arr = supplyByGood.get(s.goodId) ?? [];
      arr.push(s);
      supplyByGood.set(s.goodId, arr);
    }
    // اولین تغییرِ داخل پنجره — قیمتِ «۷ روز پیش» همان oldMinor است
    const firstLogOf = new Map<string, (typeof logs)[number]>();
    for (const lg of logs) if (!firstLogOf.has(lg.listingId)) firstLogOf.set(lg.listingId, lg);
    const changedGoods = new Set(
      supply.filter((s) => firstLogOf.has(s.id)).map((s) => s.goodId)
    );

    const rows = goodIds.map((gid) => {
      const board = supplyByGood.get(gid) ?? [];
      const buy = buyListings.find((l) => l.goodId === gid) ?? null;
      const watch = watched.find((w) => w.goodId === gid) ?? null;
      const good = goodById.get(gid);

      // ارزان‌ترین فروشنده‌ی فعال + قیمت هفت روز پیش برای روند
      let cheapest: (typeof board)[number] | null = null;
      for (const s of board) if (!cheapest || (s.priceMinor ?? 0) < (cheapest.priceMinor ?? 0)) cheapest = s;
      let trendPct: number | null = null;
      if (cheapest) {
        const pastMin = Math.min(
          ...board.map((s) => firstLogOf.get(s.id)?.oldMinor ?? (s.priceMinor as number))
        );
        if (pastMin > 0) trendPct = Math.round((((cheapest.priceMinor ?? 0) - pastMin) / pastMin) * 100);
      }
      return {
        goodId: gid,
        good: good ?? null,
        buyListingId: buy?.id ?? null,
        volume: buy?.volume ?? null,
        frequency: buy?.frequency ?? null,
        variantLabel: buy?.variantLabel ?? null,
        watched: watch !== null,
        watchedAt: watch?.createdAt ?? null,
        lastNotifiedAt: watch?.lastNotifiedAt ?? null,
        supplierCount: board.length,
        cheapest: cheapest
          ? {
              listingId: cheapest.id,
              priceMinor: cheapest.priceMinor,
              currency: cheapest.currency,
              minOrder: cheapest.minOrder,
              variantLabel: cheapest.variantLabel,
              seller: cheapest.business,
            }
          : null,
        trendPct,
        priceChanged: changedGoods.has(gid),
      };
    });

    // تابلودارها اول (قابل‌اقدام)، بعد بی‌تابلوها؛ هر گروه بر اساس تازگی
    const rowTime = (r: { watchedAt: Date | null; buyListingId: string | null }) =>
      (r.watchedAt?.getTime() ?? 0) || (r.buyListingId ? 1 : 0);
    rows.sort((a, b) => {
      const aHas = a.supplierCount > 0 ? 1 : 0;
      const bHas = b.supplierCount > 0 ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      return rowTime(b) - rowTime(a) || (b.volume ?? 0) - (a.volume ?? 0);
    });
    return rows;
  }

  /** «درخواست‌های من» (سمت خریدار — طرح ۰۸): استعلام‌هایی که فرستاده‌ام +
   *  آخرین پیشنهادِ دریافتیِ هر کدام. بج هدر = شمار پاسخ‌های دریافتی. */
  @Get("getMyInquiries")
  async getMyInquiries(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    const [rows, offers] = await Promise.all([
      this.prisma.inquiry.findMany({
        where: { buyerId: query.businessId },
        include: {
          listing: {
            select: {
              id: true, priceMinor: true, currency: true, variantLabel: true,
              good: {
                select: { id: true, nameFa: true, nameEn: true, unit: true, category: { select: { slug: true, nameFa: true, nameEn: true } } },
              },
            },
          },
          seller: { select: { id: true, slug: true, name: true, city: true, isVerified: true, trade: true, phone: true } },
        },
        orderBy: { id: "desc" },
        take: 50,
      }),
      this.prisma.offer.findMany({
        where: { buyerId: query.businessId },
        select: { id: true, listingId: true, sellerId: true, priceMinor: true, currency: true, minOrder: true, note: true, createdAt: true },
        orderBy: { id: "desc" },
      }),
    ]);
    const offerKey = new Map(offers.map((o) => [`${o.listingId}:${o.sellerId}`, o]));
    return {
      rows: rows.map((r) => ({ ...r, offer: offerKey.get(`${r.listingId}:${r.sellerId}`) ?? null })),
      answeredCount: rows.filter((r) => r.status === "ANSWERED").length,
    };
  }

  /**
   * تامین من — دوطرفه (قرینه‌ی مشتریان من):
   *   mine   → تامین‌کننده‌هایی که خودم انتخاب کرده‌ام (فالوی کاتالوگشان)
   *   theirs → فروشنده‌هایی که از بازار خریدارها، میز خرید مرا فالو کرده‌اند
   *            («خودش آمد») — تامین‌کننده‌های بالقوه‌ای که خودشان آمدند.
   * یک کسب‌وکار در هر دو سمت باشد فقط یک‌بار با origin=mine می‌آید.
   */
  @Get("getFollows")
  async getFollows(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    const pageId = await ensurePage(this.prisma, query.businessId, "BUY");
    const [mine, theirs] = await Promise.all([
      this.prisma.follow.findMany({
        where: { followerPageId: pageId },
        select: {
          createdAt: true,
          viaRef: true,
          supplierPage: {
            select: { business: { select: { id: true, slug: true, name: true, city: true, isVerified: true } } },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.follow.findMany({
        where: {
          supplierPage: { businessId: query.businessId, type: "BUY" },
          followerPage: { type: "SELL" },
        },
        select: {
          createdAt: true,
          viaRef: true,
          followerPage: {
            select: { business: { select: { id: true, slug: true, name: true, city: true, isVerified: true } } },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
    ]);

    const mineRows = mine.map((r) => ({
      supplierId: r.supplierPage.business.id,
      createdAt: r.createdAt,
      viaRef: r.viaRef,
      origin: "mine" as const,
      supplier: {
        slug: r.supplierPage.business.slug,
        name: r.supplierPage.business.name,
        city: r.supplierPage.business.city,
        isVerified: r.supplierPage.business.isVerified,
      },
    }));
    const seen = new Set(mineRows.map((r) => r.supplierId));
    const theirsRows = theirs
      .map((r) => ({
        supplierId: r.followerPage.business.id,
        createdAt: r.createdAt,
        viaRef: r.viaRef,
        origin: "theirs" as const,
        supplier: {
          slug: r.followerPage.business.slug,
          name: r.followerPage.business.name,
          city: r.followerPage.business.city,
          isVerified: r.followerPage.business.isVerified,
        },
      }))
      .filter((r) => !seen.has(r.supplierId));

    return [...mineRows, ...theirsRows].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
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
      select: { id: true, ownerId: true },
    });
    if (!supplier) throw AppError.notFound("Supplier not found");

    const followerPageId = await ensurePage(this.prisma, business.id, "BUY");
    const supplierPageId = await ensurePage(this.prisma, body.supplierId, "SELL");
    const existed = await this.prisma.follow.findUnique({
      where: { followerPageId_supplierPageId: { followerPageId, supplierPageId } },
      select: { id: true },
    });
    await this.prisma.follow.upsert({
      where: { followerPageId_supplierPageId: { followerPageId, supplierPageId } },
      create: { followerPageId, supplierPageId },
      update: {},
    });
    // فالوی تازه = مشتری جدید — صاحب کاتالوگ باید همین حالا بداند
    if (!existed && supplier.ownerId) {
      await this.notifications.push({
        userId: supplier.ownerId,
        type: "FOLLOW_SUPPLIER",
        actorId: business.id,
        actorName: business.name,
        actorSlug: business.slug,
      });
    }
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
            isActive: true,
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
      () => this.matching.suppliersForBuyer(business.id, { city: business.city, province: business.province, country: business.country })
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
                  where: { isActive: true, mode: { in: ["BUY", "BOTH"] }, volume: { not: null } },
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
      () => this.matching.buyRequestsFor(business.id, { city: business.city, province: business.province, country: business.country })
    );
    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  }
}
