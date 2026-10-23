import { Injectable, HttpStatus } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.module";
import { CacheService } from "../common/cache/cache.module";
import { AppError } from "../common/errors/app-error";
import { SettingsService } from "../settings/settings.service";
import { NotificationsService } from "../notifications/notifications.service";
import { REFERRAL_REWARD_MINOR } from "../wallet/wallet.service";
import { SCORE_ITEMS, SCORE_ITEMS_SELL, SCORE_ITEMS_BUY, type ScoreItemDef, type ScoreArm } from "./score-items";

/** «۲ هفته فعالیت منظم» — از تولد کسب‌وکار (حضور منظم، نه لاگین) */
const TWO_WEEKS_MS = 14 * 86_400_000;

export interface ScoreItemState {
  id: string;
  title: string;
  sub: string;
  pts: number;
  done: boolean;
  doneAt: Date | null;
}

export interface ScoreDeskNext {
  /** جملهٔ گام بعدی — عین متن طرح (FD-6/7) */
  t: string;
  /** مقصد دکمه (مسیر وب اپ) */
  go: string;
  /** امتیاز مانده تا ۱۰۰ (شتابدهی) */
  remaining: number;
}

export interface ScoreArmState {
  arm: ScoreArm;
  score: number;
  /** موتور شتاب‌دهندهٔ این بازو فعال است؟ (score >= آستانهٔ شبکهٔ باز) */
  open: boolean;
  items: ScoreItemState[];
  deskNext: ScoreDeskNext | null;
}

export interface ScoreState {
  required: number;
  sell: ScoreArmState;
  buy: ScoreArmState;
}

/**
 * M7 — موتور امتیاز دوگانه.
 *
 * معماری «بازسازی از روی دادهٔ زنده»:
 * انجام‌شدنِ هر آیتم از شمارنده‌های واقعی دیتابیس استنتاج می‌شود
 * (کاتالوک/فالو/سفارش بسته/استعلام/عمر کسب‌وکار)؛ ScoreEvent فقط
 * «کِی/چرا» را ثبت می‌کند (گزارش + یکتایی). این انتخاب سه چیز می‌دهد:
 *   ۱. هیچ رویدادی «جا نمی‌ماند» — گیت/میز هر خواندن خودش را شفا می‌دهد.
 *   ۲. تعمیر داده هرگز امتیاز کاذب به جا نمی‌گذارد.
 *   ۳. اهدای رویداد-محور (خواستهٔ سند ۰۸ §M7) همان فراخوانیِ syncBusiness
 *      در لحظهٔ گذار است (orders.deliver → onOrderDelivered) — برای
 *      اعلانِ «موتور فعال شد» که نباید تا باز شدن بعدیِ میز صبر کند.
 *
 * قاعدهٔ آهنین: امتیاز هرگز جریان اصلی را نمی‌شکند — همهٔ نوشتن‌ها
 * best-effort و در try/catch هستند.
 */
@Injectable()
export class ScoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService
  ) {}

  /** GET /score — خوراک کامل صفحهٔ ۱۵ + کارت گام بعدی میزها */
  async getScore(businessId: string): Promise<ScoreState & { scoreSell: number; scoreBuy: number }> {
    const { state } = await this.syncBusiness(businessId);
    // راحتی فرانت: همان دو شمارهٔ denormalized (چیپ اپ‌بار) هم top-level
    return { scoreSell: state.sell.score, scoreBuy: state.buy.score, ...state };
  }

  /** گیتِ شبکهٔ باز (§۴.۴) — منابع سمت سرور: بازوی همان عمل واجد شرط است */
  async assertArmOpen(businessId: string, arm: ScoreArm, message: string): Promise<void> {
    const { state } = await this.syncBusiness(businessId);
    const a = arm === "sell" ? state.sell : state.buy;
    if (a.score >= state.required) return;
    throw new AppError(
      "OPEN_SCORE_GATE",
      message,
      HttpStatus.FORBIDDEN,
      { arm, score: a.score, required: state.required }
    );
  }

  /**
   * گذارِ «سفارش بسته شد» (تحویل خریدار یا بستنِ تنبلِ ۷روزه) — sc7 به
   * فروشنده و sb7 به خریدار. refId = orderId (پیوند اثبات، یکتا به‌ازای آیتم).
   */
  async onOrderDelivered(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { buyerId: true, sellerId: true },
    });
    if (!order) return;
    await this.syncBusiness(order.sellerId, { sc7: orderId }).catch(() => null);
    await this.syncBusiness(order.buyerId, { sb7: orderId }).catch(() => null);
  }

  /**
   * بازسازی کامل وضعیت یک کسب‌وکار:
   *   ۱. شمارنده‌های واقعی خوانده می‌شوند (۹+۹ استنتاج).
   *   ۲. آیتم‌های تازه‌انجام‌شده رویداد می‌گیرند (یکتا؛ رقابت بی‌صدا).
   *   ۳. شمارنده‌های denormalized (scoreSell/scoreBuy) فقط در صورت تفاوت
   *      نوشته می‌شوند + کش‌های وابسته باطل می‌شوند.
   *   ۴. عبور از آستانهٔ ۱۰۰ ⇐ یک اعلان SCORE (رویدادِ یک‌بار در عمر).
   */
  async syncBusiness(
    businessId: string,
    refIds: Record<string, string> = {}
  ): Promise<{ state: ScoreState; changed: boolean }> {
    const biz = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true,
        slug: true,
        name: true,
        city: true,
        trade: true,
        tradeId: true,
        catalogCount: true,
        createdAt: true,
        scoreSell: true,
        scoreBuy: true,
        ownerId: true,
      },
    });
    if (!biz) throw AppError.notFound("Business not found");

    const [events, watched, buyListings, customers, suppliers, deliveredSell, deliveredBuy, offersSent, inquiriesCreated, required] =
      await Promise.all([
        this.prisma.scoreEvent.findMany({
          where: { businessId },
          select: { item: true, createdAt: true },
        }),
        this.prisma.watchedGood.findMany({
          where: { businessId },
          select: { goodId: true },
          take: 1_000,
        }),
        this.prisma.listing.findMany({
          where: { businessId, isActive: true, mode: { in: ["BUY", "BOTH"] } },
          select: { goodId: true },
          take: 1_000,
        }),
        this.prisma.follow.count({
          where: { supplierPage: { businessId, type: "SELL" } },
        }),
        this.prisma.follow.count({
          where: { followerPage: { businessId, type: "BUY" } },
        }),
        this.prisma.order.count({ where: { sellerId: businessId, status: "DELIVERED" } }),
        this.prisma.order.count({ where: { buyerId: businessId, status: "DELIVERED" } }),
        this.prisma.offer.count({ where: { sellerId: businessId } }),
        this.prisma.inquiry.count({ where: { buyerId: businessId } }),
        this.settings.openScoreThreshold(),
      ]);

    /* ── استنتاج انجام‌شدن (۹+۹) ─────────────────────────────────────── */
    // sc1/sb1 — «نام، شهر و صنف»: ثبت‌نامِ کامل آن را کامل می‌کند؛ رویدادِ
    // تولد (۵ امتیاز دستور مالک M3) هم انجام‌شدنش را قفل می‌کند.
    const infoComplete = !!(
      biz.name &&
      biz.name !== "کاتالوک شما" &&
      biz.city &&
      biz.city !== "—" &&
      (biz.trade || biz.tradeId)
    );
    const catalog = biz.catalogCount ?? 0;
    // لیست خرید = اجتماع کالاهای تحت‌ نظر (Watched) ∪ آگهی‌های BUY — هم‌قالب getBuyList
    const buyList = new Set([...watched.map((w) => w.goodId), ...buyListings.map((l) => l.goodId)]).size;
    const twoWeeksOld = Date.now() - biz.createdAt.getTime() >= TWO_WEEKS_MS;

    const derived: Record<string, boolean> = {
      sc1: infoComplete,
      sc2: catalog >= 1,
      sc3: catalog >= 3,
      sc4: catalog >= 5,
      sc5: customers >= 3,
      sc6: customers >= 5,
      sc7: deliveredSell >= 1,
      sc8: offersSent >= 1,
      sc9: twoWeeksOld,
      sb1: infoComplete,
      sb2: buyList >= 1,
      sb3: buyList >= 3,
      sb4: buyList >= 5,
      sb5: suppliers >= 3,
      sb6: suppliers >= 5,
      sb7: deliveredBuy >= 1,
      sb8: inquiriesCreated >= 1,
      sb9: twoWeeksOld,
    };

    const hasEvent = new Set(events.map((e) => e.item));
    const doneAtOf = (item: string) => events.find((e) => e.item === item)?.createdAt ?? null;

    const armState = (arm: ScoreArm, defs: ScoreItemDef[]): ScoreArmState => {
      const items: ScoreItemState[] = defs.map((d) => ({
        id: d.id,
        title: d.title,
        sub: d.sub,
        pts: d.pts,
        done: hasEvent.has(d.id) || !!derived[d.id],
        doneAt: doneAtOf(d.id),
      }));
      const score = items.reduce((t, it) => t + (it.done ? it.pts : 0), 0);
      const firstTodo = items.find((it) => !it.done && defs.find((d) => d.id === it.id)?.desk);
      const deskDef = firstTodo ? defs.find((d) => d.id === firstTodo.id)?.desk : undefined;
      return {
        arm,
        score,
        open: score >= required,
        items,
        deskNext:
          deskDef && firstTodo
            ? { t: deskDef.t, go: deskDef.go, remaining: Math.max(0, 100 - score) }
            : null,
      };
    };

    const sell = armState("sell", SCORE_ITEMS_SELL as unknown as ScoreItemDef[]);
    const buy = armState("buy", SCORE_ITEMS_BUY as unknown as ScoreItemDef[]);
    const state: ScoreState = { required, sell, buy };

    /* ── رویدادهای تازه (best-effort؛ یکتایی با P2002 بلعیده می‌شود) ── */
    for (const it of [...sell.items, ...buy.items]) {
      if (it.done && !hasEvent.has(it.id)) {
        await this.prisma.scoreEvent
          .create({ data: { businessId, item: it.id, refId: refIds[it.id] ?? null } })
          .then(() => {
            it.doneAt = new Date();
          })
          .catch(() => null);
      }
    }

    /* ── هم‌گامی شمارنده‌های denormalized + باطل‌کردن کش‌ها ─────────── */
    let changed = false;
    if (sell.score !== biz.scoreSell || buy.score !== biz.scoreBuy) {
      changed = true;
      await this.prisma.business
        .update({
          where: { id: businessId },
          data: { scoreSell: sell.score, scoreBuy: buy.score },
          select: { id: true },
        })
        .catch(() => null);
      this.cache.invalidateTag(`business:${businessId}`);
      this.cache.invalidateTag(`business:slug:${biz.slug}`);
      // گیت‌های سمت خریدارِ این کسب‌وکار از امتیاز تازه‌اند
      this.cache.invalidateTag(`market:sugg:${businessId}`);
      this.cache.invalidateTag(`market:supdir:${businessId}`);
      this.cache.invalidateTag(`market:buyreq:${businessId}`);
    }

    /* ── اعلانِ عبور از آستانه (رویدادِ یک‌بارِ «موتور فعال شد») ──────── */
    if (biz.ownerId) {
      const crossedSell = sell.score >= required && biz.scoreSell < required;
      const crossedBuy = buy.score >= required && biz.scoreBuy < required;
      if (crossedSell || crossedBuy) {
        const arm = crossedSell ? "sell" : "buy";
        await this.notifications
          .push({
            userId: biz.ownerId,
            bizId: businessId,
            type: "SCORE",
            title:
              arm === "sell"
                ? "امتیاز فعالیت فروشت به ۱۰۰ رسید — موتور شتاب‌دهنده فعال شد"
                : "امتیاز فعالیت خریدت به ۱۰۰ رسید — موتور شتاب‌دهنده فعال شد",
            good: arm === "sell" ? "محصولاتت به خریداران شبکه معرفی می‌شود" : "تأمین‌کننده‌های تازه به تو معرفی می‌شوند",
            url: `/home/score?arm=${arm}`,
          })
          .catch(() => null);
      }
    }

    return { state, changed };
  }

  /**
   * GET /score/referrals — صفحهٔ دعوت‌شدگان (۰۶): آمار/هدف/لیست.
   * منبع: User.referredBy (مالک این کسب‌وکار) + پاداش کیف (REFERRAL_REWARD).
   */
  async getReferrals(businessId: string) {
    const biz = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, ownerId: true, slug: true },
    });
    if (!biz) throw AppError.notFound("Business not found");

    const [users, wallet] = await Promise.all([
      biz.ownerId
        ? this.prisma.user.findMany({
            where: { referredById: biz.ownerId },
            select: { id: true, name: true, phone: true, createdAt: true, refArm: true },
            orderBy: { createdAt: "desc" },
            take: 100,
          })
        : Promise.resolve([]),
      this.prisma.wallet.findUnique({
        where: { businessId },
        select: {
          txns: {
            where: { type: "REFERRAL_REWARD" },
            select: { ref: true, amountMinor: true },
          },
        },
      }),
    ]);

    const rewarded = new Set((wallet?.txns ?? []).map((t) => t.ref).filter((x): x is string => !!x));
    const earnedMinor = (wallet?.txns ?? []).reduce((t, x) => t + x.amountMinor, 0);

    return {
      count: users.length,
      /** هدف = پلهٔ آخر دعوت (sc6/sb6 = ۵ نفر) — هم‌راستا با آیتم‌های امتیاز */
      goal: 5,
      rewardMinor: REFERRAL_REWARD_MINOR,
      earnedMinor,
      /** لینک دعوتِ هر دو بازو — برای شیت اشتراک/صفحهٔ دعوت‌شدگان */
      links: {
        catalog: `/c/${biz.slug}?ref=${biz.slug}`,
        buyList: `/buy/${biz.slug}?ref=buy:${biz.slug}`,
      },
      items: users.map((u) => ({
        name: u.name,
        phone: u.phone,
        joinedAt: u.createdAt,
        /** SELL = از لینک کاتالوک آمده (مشتری من) · BUY = از لینک میز خرید (تأمین‌کننده من) */
        arm: (u.refArm === "BUY" ? "BUY" : "SELL") as "SELL" | "BUY",
        rewarded: rewarded.has(u.id),
      })),
    };
  }
}
