import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.module";
import { SettingsService } from "../settings/settings.service";
import { NotificationsService } from "../notifications/notifications.service";
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

/** انواع تبلیغ (M9 · سند ۰۳ §۳.۴ — N7/P-3) */
export type PromoType = "CAMPAIGN" | "TARGETED";
/** جایگاه‌های هدفمند — فقط TARGETED */
export type PromoPlacement = "SAVED_CATALOGS" | "SUPPLY_BOARD";

const PLACEMENTS: PromoPlacement[] = ["SAVED_CATALOGS", "SUPPLY_BOARD"];
const DURATIONS = [3, 7, 14];

/**
 * تبلیغ نوع‌دار «صف اول» — پرداخت به‌ازای نتیجه (طرح ۸ + M9):
 * ۱٬۰۰۰ تومان هر نمایشِ هدفمند + ۵٬۰۰۰ تومان هر ذخیرهٔ حاصل — مشترک
 * بین هر دو نوع. بودجه در شروع از کیف قفل می‌شود (اِسکرو)؛ هر رویداد
 * از بودجه کم می‌شود و با تمام شدنش نمایش می‌ایستد. توقف دستی باقیمانده
 * را برمی‌گرداند؛ پایان مدتِ کمپین هم همین‌طور (lazy در خواندن).
 *  • CAMPAIGN — کمپین فروش ویژه با مدت ۳/۷/۱۴ روز؛ دیده‌شدنِ گسترده
 *    (هم کاتالوک‌های ذخیره‌شده، هم تابلوی تأمین همان کالا).
 *  • TARGETED — یک جایگاهِ جراحی‌وار: SAVED_CATALOGS یا SUPPLY_BOARD.
 * رتبهٔ تطبیق هرگز پولی نیست — تبلیغ فقط دیده‌شدن می‌خرد.
 */
@Injectable()
export class PromosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: WalletService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** ساخت تبلیغ — قفل بودجه از کیف در همان تراکنش (اتمیک) */
  async create(
    businessId: string,
    listingId: string,
    budgetMinor: number,
    type: PromoType = "CAMPAIGN",
    opts: { durationDays?: number; placement?: PromoPlacement } = {}
  ) {
    // اعتبارسنجی نوع‌دار — سند ۰۳ §۳.۴: مدت فقط کمپین، جایگاه فقط هدفمند
    let endsAt: Date | null = null;
    if (type === "CAMPAIGN") {
      if (!DURATIONS.includes(opts.durationDays ?? -1)) {
        throw new Error("PROMO_BAD_DURATION");
      }
      endsAt = new Date(Date.now() + (opts.durationDays as number) * 86_400_000);
    } else {
      if (!opts.placement || !PLACEMENTS.includes(opts.placement)) {
        throw new Error("PROMO_BAD_PLACEMENT");
      }
    }

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
    // یک تبلیغ فعال به‌ازای هر کالا — تکرار، ردیف قبلی را تازه می‌کند
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
        data: {
          businessId,
          listingId,
          budgetMinor,
          spentMinor: 0,
          type,
          placement: type === "TARGETED" ? opts.placement : null,
          durationDays: type === "CAMPAIGN" ? opts.durationDays : null,
          endsAt,
        },
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
          description:
            type === "CAMPAIGN"
              ? `قفل بودجهٔ کمپین فروش ویژه (${opts.durationDays} روز)`
              : `قفل بودجهٔ تبلیغ هدفمند (${
                  opts.placement === "SUPPLY_BOARD" ? "تابلوی تأمین" : "کاتالوک‌های ذخیره‌شده"
                })`,
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

  /**
   * پایان مدتِ کمپین — lazy در خواندن (الگوی بسته‌شدن ۷روزهٔ سفارش):
   * تبلیغِ فعالِ مدت‌داری که endsAt‌اش گذشته همان لحظه می‌ایستد و باقیماندهٔ
   * بودجه به کیف برمی‌گردد + اعلان به صاحبش. بدون job-queue (D7).
   */
  private async expireIfDue(promoId: string): Promise<boolean> {
    const promo = await this.prisma.promo.findUnique({
      where: { id: promoId },
      select: { id: true, businessId: true, isActive: true, endsAt: true, spentMinor: true, budgetMinor: true },
    });
    if (!promo || !promo.isActive || !promo.endsAt || promo.endsAt.getTime() > Date.now()) return false;
    await this.stopInternal(promo.id, promo.businessId, promo.budgetMinor - promo.spentMinor, "پایان مدت کمپین فروش ویژه");
    return true;
  }

  /** توقف داخلی — دستی، طبیعی (بودجه تمام) یا پایان مدت؛ باقیمانده برمی‌گردد */
  private async stopInternal(
    promoId: string,
    businessId: string,
    refundMinor: number,
    description: string
  ) {
    const promo = await this.prisma.$transaction(async (tx) => {
      const p = await tx.promo.update({
        where: { id: promoId },
        data: { isActive: false, stoppedAt: new Date() },
        include: { ...PROMO_INCLUDE, _count: { select: { events: true } } },
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
      return p;
    });
    // اعلانِ پایان — فقط وقتی خودش نگرفته است دست به توقف (بودجه/مدت)
    if (description !== "توقف دستی کمپین") {
      const owner = await this.prisma.business.findUnique({
        where: { id: businessId },
        select: { ownerId: true },
      });
      if (owner?.ownerId) {
        await this.notifications
          .push({
            userId: owner.ownerId,
            bizId: businessId,
            type: "AD_BUDGET_END",
            title:
              description === "پایان مدت کمپین فروش ویژه"
                ? "کمپین فروش ویژه‌ات به پایان رسید"
                : "بودجهٔ تبلیغ تمام شد",
            good: promo.listing?.good?.nameFa ?? null,
            url: "/sell/promo",
          })
          .catch(() => {});
      }
    }
    return promo;
  }

  /**
   * ثبت رویداد و کسر بودجه — یکتا به‌ازای (تبلیغ × خریدار × نوع):
   * تکرار بی‌صدا است؛ بودجه که برای این نوع رویداد جا نداشته باشد
   * رویداد ثبت نمی‌شود (ذخیرهٔ خریدار همچنان انجام می‌شود، فقط پولی
   * شمرده نمی‌شود). وقتی باقیمانده حتی یک نمایش هم نگیرد، کمپین
   * طبیعتاً می‌ایستد و گردِ باقیمانده برمی‌گردد. مدت‌دارِ گذشته هم
   * دیگر خرج نمی‌کند (پایان مدت در همان خواندنِ بعدی settle می‌شود).
   */
  async chargeEvent(
    promoId: string,
    viewerBusinessId: string,
    type: "VIEW" | "FOLLOW"
  ): Promise<boolean> {
    const cost = type === "VIEW" ? PROMO_VIEW_MINOR : PROMO_FOLLOW_MINOR;
    const promo = await this.prisma.promo.findUnique({
      where: { id: promoId },
      select: {
        id: true,
        businessId: true,
        isActive: true,
        budgetMinor: true,
        spentMinor: true,
        endsAt: true,
        listingId: true,
      },
    });
    if (!promo || !promo.isActive) return false;
    if (promo.businessId === viewerBusinessId) return false; // خودِ فروشنده
    if (promo.endsAt && promo.endsAt.getTime() <= Date.now()) {
      await this.stopInternal(promo.id, promo.businessId, promo.budgetMinor - promo.spentMinor, "پایان مدت کمپین فروش ویژه");
      return false;
    }
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
      select: { budgetMinor: true, spentMinor: true, isActive: true, endsAt: true },
    });
    if (after?.isActive) {
      const budgetOut = after.budgetMinor - after.spentMinor < PROMO_VIEW_MINOR;
      const periodOut = !!after.endsAt && after.endsAt.getTime() <= Date.now();
      if (budgetOut) {
        await this.stopInternal(promoId, promo.businessId, 0, "پایان طبیعی بودجه");
      } else if (periodOut) {
        await this.stopInternal(promoId, promo.businessId, after.budgetMinor - after.spentMinor, "پایان مدت کمپین فروش ویژه");
      }
    }

    // M10 (N5) — بازدیدِ شارژیِ تبلیغ ردیف تاریخچهٔ کالا هم می‌گیرد
    // (الگوی سند ۰۳ §۴.۴: CAMPAIGN_VIEW شارژ می‌شود پس ثبت می‌شود)
    if (type === "VIEW" && promo.listingId) {
      try {
        const viewer = await this.prisma.business.findUnique({
          where: { id: viewerBusinessId },
          select: { name: true },
        });
        await this.prisma.listingEventLog.create({
          data: {
            listingId: promo.listingId,
            type: "CAMPAIGN_VIEW",
            actorBusinessId: viewerBusinessId,
            actorName: viewer?.name ?? null,
          },
        });
      } catch {
        /* best-effort — تاریخچه هرگز شارژ را نمی‌شکند */
      }
    }
    return true;
  }

  /**
   * تزریق تبلیغ به تابلوی ذخیره‌شدهٔ خریدار (U05/U06 — جایگاه
   * SAVED_CATALOGS) — فقط تبلیغ‌های فعالِ کالاهای لیست خرید او، از
   * فروشنده‌هایی که هنوز ذخیره نکرده؛ هر نمایشِ تازه ۱٬۰۰۰ تومان از
   * بودجه کم می‌کند (یکتا در PromoEvent). برمی‌گرداند: صف قابل نمایش
   * (حداکثر ۵ — شلوغی ممنوع).
   *  • TARGETED/SAVED_CATALOGS → فقط همین جایگاه
   *  • CAMPAIGN → گسترده: این جایگاه + تابلوی تأمین (عرض بیشتر)
   */
  async injectPromos(viewerBusinessId: string, goodIds: string[]) {
    return this.inject(viewerBusinessId, goodIds, "SAVED_CATALOGS");
  }

  /**
   * تزریق به تابلوی تأمینِ همان کالا (جایگاه SUPPLY_BOARD — getSupplyBoard):
   * ردیفِ فروشندهٔ تبلیغ‌کننده با برچسب sponsored بالا می‌نشیند.
   */
  async injectBoard(viewerBusinessId: string, goodId: string) {
    const rows = await this.inject(viewerBusinessId, [goodId], "SUPPLY_BOARD");
    return rows[0] ?? null;
  }

  /** موتور مشترک تزریق — placement-aware */
  private async inject(viewerBusinessId: string, goodIds: string[], placement: PromoPlacement) {
    if (goodIds.length === 0) return [];
    const promos = await this.prisma.promo.findMany({
      where: {
        isActive: true,
        businessId: { not: viewerBusinessId },
        listing: { goodId: { in: goodIds }, isActive: true, mode: { in: ["SELL", "BOTH"] } },
        OR: [{ type: "CAMPAIGN" }, { type: "TARGETED", placement }],
      },
      include: PROMO_INCLUDE,
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    // پایان مدتِ رسیده — همان لحظه می‌ایستد (lazy) و از صف می‌افتد
    const live: typeof promos = [];
    for (const p of promos) {
      if (p.endsAt && p.endsAt.getTime() <= Date.now()) {
        await this.stopInternal(p.id, p.businessId, p.budgetMinor - p.spentMinor, "پایان مدت کمپین فروش ویژه");
      } else {
        live.push(p);
      }
    }
    // خریدارِ ذخیره‌کرده تبلیغِ همان فروشنده را نمی‌بیند (U06)
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
    // M7 (§۴.۴) — تبلیغ هدفمند هم موتور است: فقط تبلیغ‌کننده‌ای واجد است که
    // امتیاز فعالیت فروشش به آستانهٔ شبکهٔ باز رسیده باشد (خوانش شمارندهٔ
    // denormalized — با syncBusinessِ خودش زنده می‌ماند).
    const required = await this.settings.openScoreThreshold();
    const advertiserIds = [...new Set(live.map((p) => p.businessId))];
    const openAdvertisers = new Set(
      advertiserIds.length === 0
        ? []
        : (
            await this.prisma.business.findMany({
              where: { id: { in: advertiserIds }, scoreSell: { gte: required } },
              select: { id: true },
            })
          ).map((b) => b.id)
    );
    const eligible = live.filter(
      (p) =>
        p.budgetMinor - p.spentMinor >= PROMO_VIEW_MINOR &&
        !savedSupplierBizIds.has(p.businessId) &&
        openAdvertisers.has(p.businessId)
    );
    // شمارش VIEW — بی‌صدا بودجه کم می‌شود؛ خطا جریان را نمی‌شکند
    for (const p of eligible.slice(0, 5)) {
      await this.chargeEvent(p.id, viewerBusinessId, "VIEW").catch(() => false);
    }
    return eligible.slice(0, 5);
  }

  /** گزارش عددی تبلیغ (U09/U64) — مشاهده، ذخیره، هزینه، بینندگان */
  async report(promoId: string, businessId: string) {
    await this.expireIfDue(promoId);
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
        // M9 — نوع‌دار: نوع/جایگاه/مدت/پایان مدت (گزارش تفکیکی کمپین/هدفمند)
        type: promo.type,
        placement: promo.placement,
        durationDays: promo.durationDays,
        endsAt: promo.endsAt,
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
      // فاز ۶ مهاجرت (sc-campaign «چه کسانی دیدند؟») — رویدادهای خام با
      // زمان دقیق: هر بیننده چه ساعتی دید و همان جلسه دنبال کرد یا نه.
      viewerEvents: promo.events
        .slice()
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map((e) => ({
          viewerId: e.viewerBusinessId,
          type: e.type as "VIEW" | "FOLLOW",
          at: e.createdAt,
        })),
    };
  }

  /** تبلیغ‌های من (فروشنده) — برای لیست و کارت «تبلیغ‌های من» */
  async myPromos(businessId: string) {
    // پایانِ مدتِ رسیده پیش از فهرست settle می‌شود (lazy در خواندن)
    const due = await this.prisma.promo.findMany({
      where: { businessId, isActive: true, endsAt: { lte: new Date() } },
      select: { id: true },
    });
    for (const p of due) await this.expireIfDue(p.id);
    return this.prisma.promo.findMany({
      where: { businessId },
      include: { ...PROMO_INCLUDE, _count: { select: { events: true } } },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
  }
}
