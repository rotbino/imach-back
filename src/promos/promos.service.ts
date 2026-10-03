import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.module";
import { WalletService, PROMO_VIEW_MINOR, PROMO_FOLLOW_MINOR } from "../wallet/wallet.service";

export const PROMO_INCLUDE = {
  listing: {
    select: {
      id: true,
      goodId: true,
      priceMinor: true,
      currency: true,
      variantLabel: true,
      minOrder: true,
      good: { select: { nameFa: true, nameEn: true, unit: true } },
    },
  },
  business: { select: { id: true, slug: true, name: true, city: true, isVerified: true } },
} satisfies Prisma.PromoInclude;

/**
 * کمپین «صف اول» — پرداخت به‌ازای نتیجه (طرح ۸ — U66):
 * ۱٬۰۰۰ تومان هر نمایشِ هدفمند + ۵٬۰۰۰ تومان هر ذخیرهٔ حاصل.
 * بودجه در شروع از کیف قفل می‌شود (اِسکرو)؛ هر رویداد از بودجه کم
 * می‌شود و با تمام شدنش نمایش می‌ایستد. توقف دستی باقیمانده را
 * برمی‌گرداند. رتبهٔ تطبیق هرگز پولی نیست — پرومو فقط دیده‌شدن می‌خرد.
 */
@Injectable()
export class PromosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: WalletService,
  ) {}

  /** ساخت کمپین — قفل بودجه از کیف در همان تراکنش (اتمیک) */
  async create(businessId: string, listingId: string, budgetMinor: number) {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: { id: true, businessId: true, isActive: true, mode: true, goodId: true },
    });
    if (!listing || listing.businessId !== businessId) {
      throw new Error("PROMO_LISTING_NOT_YOURS");
    }
    if (!listing.isActive || listing.mode === "BUY") {
      throw new Error("PROMO_LISTING_NOT_SELLING");
    }
    // یک کمپین فعال به‌ازای هر کالا — تکرار، ردیف قبلی را تازه می‌کند
    const running = await this.prisma.promo.findFirst({
      where: { businessId, listingId, isActive: true },
      select: { id: true },
    });
    if (running) throw new Error("PROMO_ALREADY_RUNNING");

    const wallet = await this.wallets.ensure(businessId);
    if (wallet.balanceMinor < budgetMinor) {
      throw new Error("PROMO_INSUFFICIENT_BALANCE");
    }

    return this.prisma.$transaction(async (tx) => {
      const promo = await tx.promo.create({
        data: { businessId, listingId, budgetMinor, spentMinor: 0 },
        include: PROMO_INCLUDE,
      });
      await tx.wallet.update({
        where: { id: wallet.id },
        data: { balanceMinor: { decrement: budgetMinor } },
      });
      await tx.walletTxn.create({
        data: {
          walletId: wallet.id,
          type: "PROMO_SPEND",
          amountMinor: -budgetMinor,
          ref: promo.id,
          description: "قفل بودجهٔ کمپین «صف اول»",
        },
      });
      return promo;
    });
  }

  /** توقف دستی — باقیماندهٔ بودجه به کیف برمی‌گردد (REFUND) */
  async stop(promoId: string, businessId: string) {
    const promo = await this.prisma.promo.findUnique({ where: { id: promoId } });
    if (!promo || promo.businessId !== businessId) throw new Error("PROMO_NOT_YOURS");
    if (!promo.isActive) return promo;
    return this.stopInternal(promo.id, promo.businessId, promo.budgetMinor - promo.spentMinor, "توقف دستی کمپین");
  }

  /** توقف داخلی — دستی یا طبیعی (بودجه تمام)؛ باقیمانده برمی‌گردد */
  private async stopInternal(
    promoId: string,
    businessId: string,
    refundMinor: number,
    description: string
  ) {
    return this.prisma.$transaction(async (tx) => {
      const promo = await tx.promo.update({
        where: { id: promoId },
        data: { isActive: false, stoppedAt: new Date() },
        include: PROMO_INCLUDE,
      });
      if (refundMinor > 0) {
        const wallet = await tx.wallet.upsert({
          where: { businessId },
          create: { businessId },
          update: {},
          select: { id: true },
        });
        await tx.wallet.update({
          where: { id: wallet.id },
          data: { balanceMinor: { increment: refundMinor } },
        });
        await tx.walletTxn.create({
          data: {
            walletId: wallet.id,
            type: "REFUND",
            amountMinor: refundMinor,
            ref: promoId,
            description,
          },
        });
      }
      return promo;
    });
  }

  /**
   * ثبت رویداد و کسر بودجه — یکتا به‌ازای (کمپین × خریدار × نوع):
   * تکرار بی‌صدا است؛ بودجه که برای این نوع رویداد جا نداشته باشد
   * رویداد ثبت نمی‌شود (ذخیرهٔ خریدار همچنان انجام می‌شود، فقط پولی
   * شمرده نمی‌شود). وقتی باقیمانده حتی یک نمایش هم نگیرد، کمپین
   * طبیعتاً می‌ایستد و گردِ باقیمانده برمی‌گردد.
   */
  async chargeEvent(
    promoId: string,
    viewerBusinessId: string,
    type: "VIEW" | "FOLLOW"
  ): Promise<boolean> {
    const cost = type === "VIEW" ? PROMO_VIEW_MINOR : PROMO_FOLLOW_MINOR;
    const promo = await this.prisma.promo.findUnique({
      where: { id: promoId },
      select: { id: true, businessId: true, isActive: true, budgetMinor: true, spentMinor: true },
    });
    if (!promo || !promo.isActive) return false;
    if (promo.businessId === viewerBusinessId) return false; // خودِ فروشنده
    if (promo.budgetMinor - promo.spentMinor < cost) {
      if (promo.budgetMinor - promo.spentMinor < PROMO_VIEW_MINOR) {
        await this.stopInternal(promo.id, promo.businessId, 0, "پایان طبیعی بودجه");
      }
      return false;
    }
    try {
      await this.prisma.$transaction([
        this.prisma.promoEvent.create({
          data: { promoId, viewerBusinessId, type, costMinor: cost },
        }),
        this.prisma.promo.update({
          where: { id: promoId },
          data: { spentMinor: { increment: cost } },
        }),
      ]);
    } catch (e) {
      // P2002 = یونیک: قبلاً همین رویداد شمرده شده — بی‌صدا
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return false;
      }
      throw e;
    }
    // بعد از کسر: اگر حتی یک نمایش بعدی جا نیست، توقف طبیعی + برگشت گرد
    const after = await this.prisma.promo.findUnique({
      where: { id: promoId },
      select: { budgetMinor: true, spentMinor: true, isActive: true },
    });
    if (after?.isActive && after.budgetMinor - after.spentMinor < PROMO_VIEW_MINOR) {
      await this.stopInternal(promoId, promo.businessId, 0, "پایان طبیعی بودجه");
    }
    return true;
  }

  /**
   * تزریق پرومو به تابلوی ذخیره‌شدهٔ خریدار (U05/U06) — فقط کمپین‌های
   * فعالِ کالاهای لیست خرید او، از فروشنده‌هایی که هنوز ذخیره نکرده؛
   * هر نمایشِ تازه ۱٬۰۰۰ تومان از بودجه کم می‌کند (یکتا در PromoEvent).
   * برمی‌گرداند: صف پروموی قابل نمایش (حداکثر ۵ — شلوغی ممنوع).
   */
  async injectPromos(viewerBusinessId: string, goodIds: string[]) {
    if (goodIds.length === 0) return [];
    const promos = await this.prisma.promo.findMany({
      where: {
        isActive: true,
        businessId: { not: viewerBusinessId },
        listing: { goodId: { in: goodIds }, isActive: true, mode: { in: ["SELL", "BOTH"] } },
      },
      include: PROMO_INCLUDE,
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    // خریدارِ ذخیره‌کرده پرومو نمی‌بیند (U06) — یال‌های فالویِ او
    const viewerPage = await this.prisma.page.findUnique({
      where: { businessId_type: { businessId: viewerBusinessId, type: "BUY" } },
      select: { id: true },
    });
    const savedSupplierPageIds = viewerPage
      ? (
          await this.prisma.follow.findMany({
            where: { followerPageId: viewerPage.id },
            select: { supplierPageId: true },
          })
        ).map((f) => f.supplierPageId)
      : [];
    const savedSupplierBizIds = new Set(
      savedSupplierPageIds.length === 0
        ? []
        : (
            await this.prisma.page.findMany({
              where: { id: { in: savedSupplierPageIds }, type: "SELL" },
              select: { businessId: true },
            })
          ).map((p) => p.businessId)
    );
    const eligible = promos.filter(
      (p) =>
        p.budgetMinor - p.spentMinor >= PROMO_VIEW_MINOR &&
        !savedSupplierBizIds.has(p.businessId)
    );
    // شمارش VIEW — بی‌صدا بودجه کم می‌شود؛ خطا جریان را نمی‌شکند
    for (const p of eligible.slice(0, 5)) {
      await this.chargeEvent(p.id, viewerBusinessId, "VIEW").catch(() => false);
    }
    return eligible.slice(0, 5);
  }

  /** گزارش عددی کمپین (U09/U64) — مشاهده، ذخیره، هزینه، بینندگان */
  async report(promoId: string, businessId: string) {
    const promo = await this.prisma.promo.findUnique({
      where: { id: promoId },
      include: { ...PROMO_INCLUDE, events: true },
    });
    if (!promo || promo.businessId !== businessId) throw new Error("PROMO_NOT_YOURS");
    const views = promo.events.filter((e) => e.type === "VIEW");
    const follows = promo.events.filter((e) => e.type === "FOLLOW");
    const viewerBizIds = [...new Set(views.map((v) => v.viewerBusinessId))];
    const viewerBizs = viewerBizIds.length
      ? await this.prisma.business.findMany({
          where: { id: { in: viewerBizIds } },
          select: { id: true, slug: true, name: true, city: true, isVerified: true },
        })
      : [];
    const followEvents = follows;
    const followersBizIds = [...new Set(followEvents.map((v) => v.viewerBusinessId))];
    const followersBizs = followersBizIds.length
      ? await this.prisma.business.findMany({
          where: { id: { in: followersBizIds } },
          select: { id: true, slug: true, name: true, city: true, isVerified: true },
        })
      : [];
    return {
      promo: {
        id: promo.id,
        listingId: promo.listingId,
        goodName: promo.listing.good.nameFa,
        priceMinor: promo.listing.priceMinor,
        currency: promo.listing.currency,
        budgetMinor: promo.budgetMinor,
        spentMinor: promo.spentMinor,
        remainingMinor: promo.budgetMinor - promo.spentMinor,
        isActive: promo.isActive,
        stoppedAt: promo.stoppedAt,
        createdAt: promo.createdAt,
      },
      stats: {
        views: views.length,
        follows: follows.length,
        spentMinor: promo.spentMinor,
        viewRateMinor: PROMO_VIEW_MINOR,
        followRateMinor: PROMO_FOLLOW_MINOR,
        // میانگین هزینهٔ هر ذخیره — «چند دادم تا یک مشتری؟»
        costPerFollowMinor: follows.length
          ? Math.round(promo.spentMinor / follows.length)
          : null,
      },
      viewers: viewerBizs,
      converted: followersBizs,
    };
  }

  /** کمپین‌های من (فروشنده) — برای لیست و کارت «کمپین‌های من» */
  async myPromos(businessId: string) {
    return this.prisma.promo.findMany({
      where: { businessId },
      include: { ...PROMO_INCLUDE, _count: { select: { events: true } } },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
  }
}
