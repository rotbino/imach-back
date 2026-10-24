import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
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
import { proximity } from "../common/geo/cities";
import { NotificationsService } from "../notifications/notifications.service";
import { PromosService } from "../promos/promos.service";
import { ScoreService } from "../score/score.service";
import { ListingEventsService } from "../events/listing-events.service";
import { MatchingService } from "./matching.service";
import {
  AcceptOfferDto,
  AckFollowerDto,
  ArchiveWatchedGoodDto,
  BusinessIdQueryDto,
  CustomerQueryDto,
  FollowBuyerDto,
  FollowSupplierDto,
  InquiriesQueryDto,
  NeedAlertDto,
  NeedAlertQueryDto,
  OfferBuyRequestDto,
  QuoteContextQueryDto,
  RemoveFollowerDto,
  RequestQuoteDto,
  SendOfferDto,
  SetFollowerNoteDto,
  SetLowStockDto,
  SetOfferStatusDto,
  SupplyBoardQueryDto,
  UnfollowSupplierDto,
  UnwatchGoodDto,
  WatchGoodDto,
  WatchedNeedsQueryDto,
} from "./dto/market.dto";

/** ObjectId hex guard — keeps invalid params away from Prisma. */
const isObjectId = (v: string | undefined): v is string => /^[a-f\d]{24}$/i.test(v ?? "");

/** M4 — whereٔ گروه استعلام: UUID = فقط rfqGroupId · ObjectId ۲۴hex = شامل
 *  legacy (id خودِ استعلام تک‌ردیفی) هم. رشتهٔ دیگر = فقط rfqGroupId —
 *  وگرنه Prisma روی id با «Malformed ObjectID» می‌ترکد. */
const groupWhere = (g: string) =>
  isObjectId(g) ? { OR: [{ rfqGroupId: g }, { id: g }] } : { rfqGroupId: g };

/** رقم فارسی → لاتین — برای خواندن اندازه‌ی بسته از variantLabel */
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
function toLatinDigits(s: string): string {
  return s.replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)));
}

/**
 * ضریب بسته‌بندی از variantLabel — «کیسه ۵۰ کیلویی» → ۵۰، بدون بسته → ۱.
 * مقایسه‌ی قیمتِ پیشنهادها per-base انجام می‌شود نه per-bag؛ وگرنه بسته‌ی
 * ۱۰کیلوییِ هم‌قیمت، «۵ برابر ارزان‌تر» دیده می‌شود.
 */
function packFactor(variantLabel: string | null): number {
  if (!variantLabel) return 1;
  const m = toLatinDigits(variantLabel).match(/(\d{1,4})\s*(?:کیلو|گرم|لیتر)/);
  return m ? parseInt(m[1], 10) : 1;
}

/** قیمت نرمال‌شده بر واحد پایه (per کیلو/گرم/لیتر) — برای مقایسه‌ی منصفانه */
const perBase = (s: { priceMinor: number | null; variantLabel: string | null }): number =>
  (s.priceMinor as number) / packFactor(s.variantLabel);

// ═══ M4 — استعلام چندقلمی (FD-24) — ابزارهای مشترک ═══

/** قلم استعلام — snapshot ذخیره‌شده در Inquiry.items */
interface RfqItem {
  goodId: string;
  qty: number;
  /** آگهی فروشِ «همین فروشنده» برای این قلم — null = ندارد */
  listingId: string | null;
}

/** اقلام استعلام: JSON تازه یا legacy تک‌قلمی از listing/volume */
function rfqItemsOf(row: {
  items: unknown;
  volume: number;
  listingId: string;
  listing: { goodId: string } | { good: { id: string } } | null;
}): RfqItem[] {
  const raw = row.items as unknown;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((x) => {
      const it = x as { goodId: string; qty?: number; listingId?: string | null };
      return { goodId: String(it.goodId), qty: Number(it.qty) || 1, listingId: it.listingId ? String(it.listingId) : null };
    });
  }
  const good =
    row.listing && "goodId" in row.listing
      ? (row.listing as { goodId: string }).goodId
      : row.listing?.good?.id;
  return [{ goodId: good ?? "", qty: row.volume ?? 1, listingId: row.listingId }];
}

/** عدد → رقم فارسی با جداکنندهٔ هزارگان «٬» — برای resultText سروری */
function faMoney(n: number): string {
  const fa = "۰۱۲۳۴۵۶۷۸۹";
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "٬")
    .replace(/\d/g, (d) => fa[Number(d)]);
}

const clampInt = (v: number | undefined, min: number, max: number, dflt: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
};

const DAY_MS = 86_400_000;

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
      /** M4 — برای legacy تک‌قلمی: goodId روی خود listing لازم است */
      goodId: true,
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
    private readonly notifications: NotificationsService,
    private readonly promos: PromosService,
    private readonly score: ScoreService,
    private readonly listingEvents: ListingEventsService
  ) {}

  private invalidateBuyerSide(businessId: string): void {
    this.cache.invalidateTag(`market:buyreq:${businessId}`);
    this.cache.invalidateTag(`market:supdir:${businessId}`);
    this.cache.invalidateTag(`market:sugg:${businessId}`);
  }

  /**
   * M7 (§۴.۴) — گیتِ شبکهٔ باز جایگزینِ گیتِ ۱۰-معرف شد:
   * موتور (پیشنهاد مستقیم به خریدارِ ناشناس) فقط برای فروشنده‌ای باز است
   * که امتیاز فعالیت فروشش به آستانهٔ AppSetting network.openScore رسیده
   * باشد. 403 + OPEN_SCORE_GATE؛ فرانت نوار پیشرفت را خودش می‌کشد.
   * «گوش‌به‌زنگ» بودن (فالویِ SELL من روی BUY او) همچنان خودش دعوت است.
   */
  private assertNetworkOpen(businessId: string, arm: "sell" | "buy"): Promise<void> {
    const armFa = arm === "sell" ? "فروش" : "خرید";
    return this.score.assertArmOpen(
      businessId,
      arm,
      `برای فعال شدن این امکان، امتیاز فعالیت ${armFa}ت را به آستانهٔ شبکهٔ باز برسان`
    );
  }

  /**
   * وضعیت گیتِ شبکهٔ باز (M7 §۴.۴) + زمینهٔ بازار فروش — یک فراخوان برای
   * همهٔ عناصر صفحه: امتیاز دو بازو (گیت موتور تطبیق)، کالاهای فروشی
   * (گیت کاتالوگ خالی)، و فالو/پیشنهادهای قبلی من روی خریدارها.
   * (گیتِ ۱۰-معرفِ REFERRAL_TARGET بازنشسته شد؛ سند ۰۸ §M7.)
   */
  @Get("getMarketState")
  async getMarketState(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    const [{ state }, sellListings, buyerEdges, myOffers] = await Promise.all([
      this.score.syncBusiness(business.id),
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
    return {
      open: {
        required: state.required,
        sell: { score: state.sell.score, unlocked: state.sell.open },
        buy: { score: state.buy.score, unlocked: state.buy.open },
      },
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
   *
   * M4 (FD-24) — استعلام چندقلمی:
   *   · items[] می‌آید (۱..۸ قلم، مقدار هر قلم)؛ goodId+volume = میراث تک‌قلمی.
   *   · گیرندگان چندقلمی = «اجتماع دارندگان قلم‌ها» (تیک قفلِ روشن در فرم ۲۵)؛
   *     مرتب‌سازی: پوشش نزولی، بعد ارزان‌ترین قیمت صعودی؛ سقف ۱۵.
   *   · سبد به‌عنوان snapshot روی هر ردیف می‌نشیند (items JSON) با رزولوشن
   *     per-فروشنده: listingId هر قلم = آگهیِ «همین فروشنده» (null = ندارد).
   *   · مهلت سرورمبنا: expiresDays ۱..۵ (پیش‌فرض ۳ — pills فرم ۲۵) → expiresAt.
   */
  @Post("requestQuote")
  @HttpCode(HttpStatus.CREATED)
  async requestQuote(
    @Body() body: RequestQuoteDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);

    // ── M4: سبد — چندقلمی (items[]) یا تک‌قلمی legacy (goodId+volume) ──
    const multi = (body.items?.length ?? 0) > 0;
    const basket: { goodId: string; qty: number }[] = multi
      ? body.items!.map((it) => ({ goodId: it.goodId, qty: clampInt(it.qty, 1, 1e9, 1) }))
      : body.goodId && body.volume
        ? [{ goodId: body.goodId, qty: clampInt(body.volume, 1, 1e9, 1) }]
        : [];
    if (basket.length === 0) {
      throw AppError.badRequest("اقلام استعلام را بفرست (items یا goodId+volume)", "EMPTY_BASKET");
    }
    if (new Set(basket.map((b) => b.goodId)).size !== basket.length) {
      throw AppError.badRequest("قلم تکراری در استعلام", "DUP_ITEM");
    }
    const goods = await this.prisma.good.findMany({
      where: { id: { in: basket.map((b) => b.goodId) } },
      select: { id: true, nameFa: true },
    });
    const goodMap = new Map(goods.map((g) => [g.id, g]));
    if (goods.length !== basket.length) throw AppError.notFound("Good not found");

    const hasSelection = !multi && (body.supplierIds?.length ?? 0) > 0;
    if (!multi && !hasSelection && !body.includeNetwork) {
      throw AppError.badRequest("حداقل یک تأمین‌کننده انتخاب کنید یا شبکه iMach را روشن کنید", "NO_RECIPIENT");
    }

    // ── رزولوشن گیرندگان: چندقلمی = اجتماع دارندگان (قفل) · تک‌قلمی = انتخابی ──
    const CAP = multi ? 15 : 5;
    const listingRows = await this.prisma.listing.findMany({
      where: {
        goodId: { in: basket.map((b) => b.goodId) },
        isActive: true,
        mode: { in: ["SELL", "BOTH"] },
        businessId: {
          not: business.id,
          ...(hasSelection ? { in: [...new Set(body.supplierIds as string[])] } : {}),
        },
      },
      select: { id: true, businessId: true, goodId: true, priceMinor: true },
      orderBy: { priceMinor: "asc" },
    });
    // sellerId → (goodId → ارزان‌ترین آگهی)
    const perSeller = new Map<string, Map<string, { listingId: string; price: number | null }>>();
    for (const r of listingRows) {
      let m = perSeller.get(r.businessId);
      if (!m) {
        m = new Map();
        perSeller.set(r.businessId, m);
      }
      if (!m.has(r.goodId)) m.set(r.goodId, { listingId: r.id, price: r.priceMinor }); // مرتب asc ⇒ اولین = ارزان‌ترین
    }

    // گسترش به شبکه iMach — فقط مسیر تک‌قلمی میراث (چندقلمی: اجتماع کامل است)
    if (!multi && body.includeNetwork && perSeller.size < CAP) {
      const matches = await this.matching.suppliersForNeed(
        business.id,
        { city: business.city, province: business.province, country: business.country },
        basket[0].goodId,
        basket[0].qty,
        CAP
      );
      for (const m of matches) {
        if (perSeller.size >= CAP) break;
        if (!perSeller.has(m.sellerId)) {
          perSeller.set(m.sellerId, new Map([[basket[0].goodId, { listingId: m.listingId, price: null }]]));
        }
      }
    }

    if (perSeller.size === 0) return { created: 0, groupId: null, inquiries: [] };

    // M4 — مرتب‌سازی گیرندگان: پوشش نزولی، بعد ارزان‌ترینِ اولین قلم صعودی
    const minPriceOf = (m: Map<string, { listingId: string; price: number | null }>): number => {
      const prices = [...m.values()].map((v) => v.price).filter((p): p is number => p != null);
      return prices.length ? Math.min(...prices) : Number.POSITIVE_INFINITY;
    };
    const sellers = [...perSeller.entries()]
      .sort((a, b) => b[1].size - a[1].size || minPriceOf(a[1]) - minPriceOf(b[1]))
      .slice(0, CAP);

    const note = body.note?.trim() || null;
    // فاز ۴ مهاجرت — کلید گروه: همهٔ ردیف‌های این ارسال در یک کارت «پیشنهادها»
    const rfqGroupId = randomUUID();
    const deliveryCity = body.deliveryCity?.trim() || business.city || null;
    // M4 — مهلت سرورمبنا (۱..۵ روز؛ پیش‌فرض ۳)
    const days = clampInt(body.expiresDays, 1, 5, 3);
    const expiresAt = new Date(Date.now() + days * DAY_MS);
    // ── تایم‌اوتِ تراکنش: پیش‌فرض پرایسما ۵ ثانیه است؛ از ایران هر create یک
    // رفت‌وبرگشت ~۲۰۰ms+ به Atlas دارد و تراکنشِ ۵ گیرنده مرتب کرش می‌کرد
    // (باگ واقعی که در تست E2E دیده شد — 500 روی استعلام). پنجره را ۳۰ثانیه کردیم.
    const created = await this.prisma.$transaction(
      async (tx) => {
        const inquiries = [];
        for (const [sellerId, m] of sellers) {
          // M4 — snapshot سبد با رزولوشن این فروشنده (حریم: قلم‌های بدون آگهی null)
          const items = basket.map((b) => ({
            goodId: b.goodId,
            qty: b.qty,
            listingId: m.get(b.goodId)?.listingId ?? null,
          }));
          const firstCovered = items.find((it) => it.listingId);
          if (!firstCovered) continue; // ناممکن — دارنده حداقل یک قلم دارد
          inquiries.push(
            await tx.inquiry.create({
              data: {
                buyerId: business.id,
                sellerId,
                listingId: firstCovered.listingId as string,
                volume: basket[0].qty,
                note,
                frequency: body.frequency ?? null,
                delivery: body.delivery?.trim() || null,
                deliveryCity,
                targetPriceMinor: body.targetPriceMinor ?? null,
                rfqGroupId,
                items,
                expiresAt,
              },
            })
          );
        }
        return inquiries;
      },
      { timeout: 30_000, maxWait: 10_000 }
    );

    this.invalidateBuyerSide(business.id);

    // درخواست به هر فروشنده رسید — هر مالک یک اعلان (dedupe با pushMany)
    const sellers2 = await this.prisma.business.findMany({
      where: { id: { in: [...perSeller.keys()] }, ownerId: { not: null } },
      select: { id: true, ownerId: true },
    });
    const firstGood = goodMap.get(basket[0].goodId);
    const goodLabel = multi
      ? `${firstGood?.nameFa ?? ""} +${basket.length - 1} قلم دیگر`
      : (firstGood?.nameFa ?? "");
    await this.notifications.pushMany(
      sellers2.map((s) => ({
        userId: s.ownerId as string,
        // فاز ۸ — گیتِ «درخواست‌ها و پاسخ‌های قیمت» از notifPrefs
        bizId: s.id,
        type: "QUOTE" as const,
        actorId: business.id,
        actorName: business.name,
        actorSlug: business.slug,
        good: goodLabel,
        // M10 — مقصد لمس: میز استعلام فروشنده (گوش-به-زنگ + مستقیم)
        url: "/sell/rfqs",
      }))
    );

    // ── M10 (N6 · سند ۰۸ §M10) — گوش-به-زنگ: فروشنده‌هایی که زنگوله روی
    // (این خریدار × همین اقلام) روشن کرده‌اند اما مستقیم گیرنده نشده‌اند →
    // اعلان BUYER_NEED. گیرنده‌های مستقیم بالا خودشان QUOTE گرفتند (بدون دوبل).
    try {
      const alerts = await this.prisma.needAlert.findMany({
        where: {
          buyerBusinessId: business.id,
          goodId: { in: basket.map((b) => b.goodId) },
          sellerBusinessId: { notIn: [...perSeller.keys()] },
        },
        select: { sellerBusinessId: true },
        take: 200,
      });
      const alertSellerIds = [...new Set(alerts.map((a) => a.sellerBusinessId))];
      if (alertSellerIds.length > 0) {
        const owners = await this.prisma.business.findMany({
          where: { id: { in: alertSellerIds }, ownerId: { not: null } },
          select: { id: true, ownerId: true },
        });
        await this.notifications.pushMany(
          owners.map((s) => ({
            userId: s.ownerId as string,
            bizId: s.id,
            type: "BUYER_NEED" as const,
            actorId: business.id,
            actorName: business.name,
            actorSlug: business.slug,
            good: goodLabel,
            title: `استعلام تازهٔ ${business.name} — ${goodLabel} (گوش به زنگ شما بود)`,
            url: "/sell/rfqs",
          }))
        );
      }
    } catch {
      /* best-effort — اعلان هرگز استعلام را نمی‌شکند */
    }

    // ── M10 (N5) — تاریخچهٔ رویداد کالا: INQUIRY روی اقلامِ خودِ هر فروشنده
    // (snapshot رزولوشن‌شدهٔ همان ردیف — حریم سبد خریدار حفظ می‌شود)
    for (const inq of created) {
      const items = (inq.items as { listingId: string | null }[] | null) ?? [];
      await this.listingEvents.logInquiry(items, { businessId: business.id, name: business.name });
    }

    const selectedSet = new Set(body.supplierIds ?? []);
    return {
      created: created.length,
      groupId: rfqGroupId,
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
    @CurrentLocale() locale: Locale,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    // ── بخشِ مشترک (کالا + تابلو قیمت‌ها) زیر کش ۶۰ثانیه‌ای با تگ products:
    // heavy query است (لیستینگ‌ها + priceLog + business) و برای همه‌ی خریدارانِ
    // همان کالا یکسان است — قبلاً هر فراخوان ۱.۱ ثانیه به Atlas می‌زد.
    const { value: shared, hit } = await this.cache.wrap(
      `market:board2:${query.goodId}`,
      { ttlMs: TTL.MINUTE, tags: ["products", `market:board:${query.businessId}`] },
      async () => {
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
        return { good, listings };
      }
    );
    reply.header("x-cache", hit ? "HIT" : "MISS");
    const good = shared.good;
    const listings = shared.listings.filter((l) => l.business.id !== business.id);

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
        // فاز ۱۲ — ردیف غیرفعال (آرشیوشده) هم حجم/دوره‌اش را نشان می‌دهد؛
        // id/mode/مشخصات فروش برای «ویرایش نیاز خرید» (شیت ویرایش) برمی‌گردد
        // تا ذخیرهٔ mode=BOTH سمت فروش را نزد.
        where: { businessId: business.id, goodId: good.id, mode: { in: ["BUY", "BOTH"] } },
        select: {
          id: true, mode: true, volume: true, frequency: true, variantLabel: true,
          priceMinor: true, currency: true, stock: true, minOrder: true,
        },
      }),
    ]);

    const followedSet = new Set(followedPages.map((f) => f.supplierPage.businessId));
    const boughtSet = new Set(myInquirySellers.map((i) => i.sellerId));

    // M9 — تبلیغ جایگاه SUPPLY_BOARD (طرح ۰۹ · sponsored که از فاز ۶ خالی
    // مانده بود): ردیفِ فروشندهٔ تبلیغ‌کننده برچسب می‌گیرد + VIEW همان
    // لحظه از بودجه‌اش کم می‌شود (best-effort — خطا تابلو را نمی‌شکند).
    const boardPromo = await this.promos
      .injectBoard(business.id, good.id)
      .catch(() => null);
    const sponsoredBizId = boardPromo?.businessId ?? null;

    return {
      good,
      watched: watch !== null,
      volume: myBuy?.volume ?? null,
      frequency: myBuy?.frequency ?? null,
      variantLabel: myBuy?.variantLabel ?? null,
      // فاز ۱۲ — شیت «ویرایش نیاز خرید»: ردیف فیزیکی + حالت واقعی +
      // spec فروش (فقط وقتی BOTH است، تا ویرایش سمت فروش را نکند)
      buyListingId: myBuy?.id ?? null,
      buyMode: myBuy?.mode ?? null,
      buySell:
        myBuy && myBuy.mode === "BOTH" && myBuy.priceMinor !== null
          ? {
              priceMinor: myBuy.priceMinor,
              currency: myBuy.currency,
              stock: myBuy.stock,
              minOrder: myBuy.minOrder,
            }
          : null,
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
          // M9 — «معرفی iMach» فاز ۶ حالا زنده است: تبلیغ هدفمندِ جایگاه
          // تابلوی تأمین + کمپین فروش ویژه (هر دو اینجا دیده می‌شوند)
          sponsored: sponsoredBizId === l.business.id,
        };
      }),
    };
  }

  // ═══ فاز ۷ — دایرکتوری تأمین‌کنندگان (طرح ۱۰) و پیشنهادها (طرح ۱۱) ═══

  /**
   * دایرکتوری تأمین‌کنندگان (طرح ۱۰) — دو تب، بدون دایرکتوری کل بازار:
   *   related  → پیشنهاد موتور تطبیق برای کالاهای لیست من (WatchedGood ∪ BUY)،
   *              گروه‌بندی‌شده بر حسب فروشنده با چیپ کالاهای مرتبط
   *   followed → شبکه‌ی فعلی من: فالوهای mine + theirs («خودش آمد»)
   * هر ردیف: شمارش قیمت‌های او در تابلوهای من + «از او خریده‌ام» (استعلامِ
   * پاسخ‌داده‌شده — مبادله‌ی قیمتِ واقعاً کامل‌شده، نه صرفاً سؤال).
   */
  @Get("getSuppliersDirectory")
  async getSuppliersDirectory(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    const { value, hit } = await this.cache.wrap(
      `market:supdir:${query.businessId}`,
      { ttlMs: TTL.MINUTE, tags: [`market:supdir:${query.businessId}`] },
      () => this.buildSuppliersDirectory(business)
    );
    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  }

  private async buildSuppliersDirectory(business: {
    id: string;
    city: string;
    province: string | null;
    country: string;
  }) {
    const buyerGeo = { city: business.city, province: business.province, country: business.country };

    // کالاهای من: WatchedGood ∪ BUY listing فعال — سوختِ موتور و چیپ‌ها
    const [watched, buyListings, buyPageId] = await Promise.all([
      this.prisma.watchedGood.findMany({
        where: { businessId: business.id },
        select: { goodId: true },
      }),
      this.prisma.listing.findMany({
        where: { businessId: business.id, mode: { in: ["BUY", "BOTH"] }, isActive: true },
        select: { goodId: true, volume: true },
      }),
      ensurePage(this.prisma, business.id, "BUY"),
    ]);
    const volumeByGood = new Map(buyListings.map((l) => [l.goodId, l.volume]));
    const myGoods = [...new Set([...watched.map((w) => w.goodId), ...buyListings.map((l) => l.goodId)])].map(
      (goodId) => ({ goodId, volume: volumeByGood.get(goodId) ?? null })
    );
    const myGoodIds = myGoods.map((g) => g.goodId);

    // شبکه‌ی فالو — قرینه‌ی getFollows (mine + theirs)
    const SUPPLIER_SELECT = {
      select: { id: true, slug: true, name: true, city: true, isVerified: true, trade: true },
    } as const;
    const [mine, theirs] = await Promise.all([
      this.prisma.follow.findMany({
        where: { followerPageId: buyPageId },
        select: { createdAt: true, viaRef: true, supplierPage: { select: { business: SUPPLIER_SELECT } } },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.follow.findMany({
        where: { supplierPage: { businessId: business.id, type: "BUY" }, followerPage: { type: "SELL" } },
        select: { createdAt: true, viaRef: true, followerPage: { select: { business: SUPPLIER_SELECT } } },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
    ]);
    const networkIds = new Set<string>([
      ...mine.map((f) => f.supplierPage.business.id),
      ...theirs.map((f) => f.followerPage.business.id),
    ]);

    // «از او خریده‌ام» — استعلام پاسخ‌داده‌شده (مبادله‌ی کامل‌شده‌ی قیمت)
    const answered = await this.prisma.inquiry.findMany({
      where: { buyerId: business.id, status: "ANSWERED" },
      select: { sellerId: true },
      take: 200,
    });
    const boughtSet = new Set(answered.map((a) => a.sellerId));

    // ۱) related — ردیف‌های موتور، گروه‌بندی بر حسب فروشنده
    const engine = myGoods.length
      ? await this.matching.suppliersForGoods(business.id, buyerGeo, myGoods, 24)
      : [];
    const engineBySupplier = new Map<string, typeof engine>();
    for (const row of engine) {
      const arr = engineBySupplier.get(row.supplierId) ?? [];
      arr.push(row);
      engineBySupplier.set(row.supplierId, arr);
    }
    // صنفِ فروشنده‌های مرتبط — موتور آن را نمی‌دهد؛ یک کوئری سبک
    const relatedIds = [...engineBySupplier.keys()];
    const trades = relatedIds.length
      ? await this.prisma.business.findMany({
          where: { id: { in: relatedIds } },
          select: { id: true, trade: true },
        })
      : [];
    const tradeById = new Map(trades.map((t) => [t.id, t.trade]));
    const related = [...engineBySupplier.entries()]
      .map(([supplierId, rows]) => {
        const cheapest = rows.reduce((a, b) => (b.priceMinor < a.priceMinor ? b : a));
        const goods = [...new Map(rows.map((r) => [r.goodId, r.goodName])).entries()].map(
          ([goodId, nameFa]) => ({ goodId, nameFa })
        );
        const b = cheapest;
        return {
          supplierId,
          slug: b.supplierSlug,
          name: b.supplierName,
          city: b.supplierCity,
          isVerified: b.supplierVerified,
          trade: tradeById.get(supplierId) ?? null,
          goods,
          priceCount: rows.length,
          followedByMe: networkIds.has(supplierId),
          boughtFrom: boughtSet.has(supplierId),
          // مرتب‌سازی سرور: بهترین امتیازِ ردیف‌های همان فروشنده
          sortScore: Math.max(...rows.map((r) => r.score)),
        };
      })
      .sort((a, b) => b.sortScore - a.sortScore)
      .map(({ sortScore, ...row }) => row);

    // ۲) followed — شبکه‌ی من + چیپ کالاهای مشترک
    const networkListings = networkIds.size
      ? await this.prisma.listing.findMany({
          where: {
            businessId: { in: [...networkIds] },
            goodId: { in: myGoodIds },
            isActive: true,
            mode: { in: ["SELL", "BOTH"] },
          },
          select: { businessId: true, goodId: true, good: { select: { id: true, nameFa: true } } },
        })
      : [];
    const netBySupplier = new Map<string, typeof networkListings>();
    for (const l of networkListings) {
      const arr = netBySupplier.get(l.businessId) ?? [];
      arr.push(l);
      netBySupplier.set(l.businessId, arr);
    }
    const followedRow = (
      r: { createdAt: Date; viaRef: boolean },
      b: { id: string; slug: string; name: string; city: string; isVerified: boolean; trade: string | null },
      origin: "mine" | "theirs"
    ) => {
      const listings = netBySupplier.get(b.id) ?? [];
      const goods = [...new Map(listings.map((l) => [l.good.id, l.good.nameFa])).entries()].map(
        ([goodId, nameFa]) => ({ goodId, nameFa })
      );
      return {
        supplierId: b.id,
        slug: b.slug,
        name: b.name,
        city: b.city,
        isVerified: b.isVerified,
        trade: b.trade,
        origin,
        viaRef: r.viaRef,
        createdAt: r.createdAt,
        goods,
        priceCount: listings.length,
        boughtFrom: boughtSet.has(b.id),
      };
    };
    // mine اول؛ theirs فقط اگر قبلاً در mine نبود (قرینه‌ی getFollows)
    const seenMine = new Set(mine.map((f) => f.supplierPage.business.id));
    const followed = [
      ...mine.map((f) => followedRow(f, f.supplierPage.business, "mine")),
      ...theirs
        .filter((f) => !seenMine.has(f.followerPage.business.id))
        .map((f) => followedRow(f, f.followerPage.business, "theirs")),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return { related, followed };
  }

  /**
   * پیشنهادهای iMach (طرح ۱۱) — سه کارت، همه از داده‌ی واقعی:
   *   betterPrices  → برای هر کالای لیست من: تأمین‌کننده‌ای خارج از شبکه‌ام که
   *                   از بهترین قیمتِ شبکه‌ی فعلی‌ام ارزان‌تر است («قیمت بهتر»)
   *   newSuppliers  → تأمین‌کننده‌ی تازه از موتور تطبیق: نه فالو، نه سابقه، نه
   *                   صاحبِ کارتِ قیمتِ بهتر — با امتیاز تطبیق (MatchRing)
   *   alternatives  → کالای هم‌دسته‌ی ارزان‌تر از ارزان‌ترینِ تابلوی کالای من
   *                   («جایگزین» — مثل طارم به‌جای هاشمی)
   */
  @Get("getSuggestions")
  async getSuggestions(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    // M7 (§۴.۴) — گیتِ شبکهٔ باز «پیش از کش» خوانده می‌شود تا تغییرِ آستانه از
    // پنل ادمین بلافاصله اثر کند (کش فقط محاسبهٔ سنگینِ حالتِ باز را نگه می‌دارد).
    const { state: lock } = await this.score.syncBusiness(business.id);
    if (!lock.buy.open) {
      reply.header("x-cache", "LOCKED");
      return {
        locked: true,
        required: lock.required,
        score: lock.buy.score,
        betterPrices: [],
        newSuppliers: [],
        alternatives: [],
      };
    }
    const { value, hit } = await this.cache.wrap(
      `market:sugg:${query.businessId}`,
      { ttlMs: TTL.MINUTE, tags: [`market:sugg:${query.businessId}`] },
      () => this.buildSuggestions(business)
    );
    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  }

  private async buildSuggestions(business: {
    id: string;
    city: string;
    province: string | null;
    country: string;
  }) {
    // M7 (§۴.۴) — موتور تطبیق فقط برای خریدارِ ۱۰۰+ باز است؛ قفل ⇐ پاسخ
    // سبکِ locked (فرانت کارت/نوار پیشرفت را می‌کشد) — محاسبهٔ سنگین نمی‌دود.
    const { state: score } = await this.score.syncBusiness(business.id);
    if (!score.buy.open) {
      return {
        locked: true,
        required: score.required,
        score: score.buy.score,
        betterPrices: [],
        newSuppliers: [],
        alternatives: [],
      };
    }
    const buyerGeo = { city: business.city, province: business.province, country: business.country };

    // زمینه‌ی خریدار: کالاهای من + شبکه‌ام + سابقه‌ی استعلام
    const [watched, buyListings, buyPageId, inquiries] = await Promise.all([
      this.prisma.watchedGood.findMany({
        where: { businessId: business.id },
        select: { goodId: true },
      }),
      this.prisma.listing.findMany({
        where: { businessId: business.id, mode: { in: ["BUY", "BOTH"] }, isActive: true },
        select: { goodId: true, volume: true },
      }),
      ensurePage(this.prisma, business.id, "BUY"),
      this.prisma.inquiry.findMany({
        where: { buyerId: business.id },
        select: { sellerId: true },
        take: 200,
      }),
    ]);
    const volumeByGood = new Map(buyListings.map((l) => [l.goodId, l.volume]));
    const myGoods = [...new Set([...watched.map((w) => w.goodId), ...buyListings.map((l) => l.goodId)])].map(
      (goodId) => ({ goodId, volume: volumeByGood.get(goodId) ?? null })
    );
    const myGoodIds = myGoods.map((g) => g.goodId);
    if (myGoodIds.length === 0) return { betterPrices: [], newSuppliers: [], alternatives: [] };

    const follows = await this.prisma.follow.findMany({
      where: { followerPageId: buyPageId, supplierPage: { type: "SELL" } },
      select: { supplierPage: { select: { businessId: true } } },
    });
    const theirs = await this.prisma.follow.findMany({
      where: { supplierPage: { businessId: business.id, type: "BUY" }, followerPage: { type: "SELL" } },
      select: { followerPage: { select: { business: { select: { id: true } } } } },
      take: 200,
    });
    const networkIds = new Set<string>([
      ...follows.map((f) => f.supplierPage.businessId),
      ...theirs.map((f) => f.followerPage.business.id),
    ]);
    const inquiredSet = new Set(inquiries.map((i) => i.sellerId));

    // کل تابلوی کالاهای من — بنیانِ هر سه کارت
    const [goods, supply] = await Promise.all([
      this.prisma.good.findMany({
        where: { id: { in: myGoodIds } },
        select: { id: true, nameFa: true, unit: true, categoryId: true },
      }),
      this.prisma.listing.findMany({
        where: {
          goodId: { in: myGoodIds },
          businessId: { not: business.id },
          isActive: true,
          mode: { in: ["SELL", "BOTH"] },
          priceMinor: { not: null },
        },
        select: {
          id: true,
          goodId: true,
          priceMinor: true,
          currency: true,
          minOrder: true,
          stock: true,
          variantLabel: true,
          updatedAt: true,
          city: true,
          province: true,
          country: true,
          business: { select: { id: true, slug: true, name: true, city: true, isVerified: true, trade: true, province: true, country: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: 300,
      }),
    ]);
    const goodById = new Map(goods.map((g) => [g.id, g]));
    const supplyByGood = new Map<string, typeof supply>();
    for (const s of supply) {
      const arr = supplyByGood.get(s.goodId) ?? [];
      arr.push(s);
      supplyByGood.set(s.goodId, arr);
    }

    // ۱) قیمت بهتر — ارزان‌ترینِ خارج از شبکه‌ام در برابر بهترینِ شبکه‌ام
    // مقایسه per-base (کیلو/گرم/لیتر) — بسته‌های کوچک «ارزان‌تر» دیده نمی‌شوند
    interface BetterPriceRow {
      goodId: string;
      goodName: string;
      unit: string;
      listingId: string;
      priceMinor: number;
      currency: string | null;
      minOrder: number | null;
      stock: number | null;
      variantLabel: string | null;
      boardBestMinor: number;
      pct: number;
      supplier: (typeof supply)[number]["business"];
    }
    const betterPrices: BetterPriceRow[] = [];
    const betterSupplierIds = new Set<string>();
    for (const gid of myGoodIds) {
      const board = supplyByGood.get(gid) ?? [];
      const mineNetwork = board.filter((s) => networkIds.has(s.business.id));
      if (mineNetwork.length === 0) continue; // تابلویی از شبکه‌ام نیست — مرجع مقایسه نداریم
      const boardBest = Math.min(...mineNetwork.map(perBase));
      const candidates = board.filter(
        (s) => !networkIds.has(s.business.id) && perBase(s) < boardBest * 0.99
      );
      if (candidates.length === 0) continue;
      const cheapest = candidates.reduce((a, b) => (perBase(b) < perBase(a) ? b : a));
      betterSupplierIds.add(cheapest.business.id);
      betterPrices.push({
        goodId: gid,
        goodName: goodById.get(gid)?.nameFa ?? "",
        unit: goodById.get(gid)?.unit ?? "",
        listingId: cheapest.id,
        priceMinor: cheapest.priceMinor as number,
        currency: cheapest.currency,
        minOrder: cheapest.minOrder,
        stock: cheapest.stock,
        variantLabel: cheapest.variantLabel,
        boardBestMinor: Math.round(boardBest * packFactor(cheapest.variantLabel)),
        pct: Math.round(((boardBest - perBase(cheapest)) / boardBest) * 100),
        supplier: cheapest.business,
      });
    }
    betterPrices.sort((a, b) => b.pct - a.pct);

    // ۲) تأمین‌کننده جدید — موتور تطبیق، خارج از شبکه/سابقه/کارتِ قیمتِ بهتر
    const engine = await this.matching.suppliersForGoods(business.id, buyerGeo, myGoods, 24);
    const seenSuppliers = new Set<string>();
    const newSuppliers: {
      supplier: { id: string; slug: string; name: string; city: string; isVerified: boolean };
      score: number;
      goodId: string;
      goodName: string;
      unit: string;
      priceMinor: number;
      currency: string | null;
      minOrder: number;
      myVolume: number | null;
      proximity: string;
    }[] = [];
    for (const row of engine) {
      if (seenSuppliers.has(row.supplierId)) continue;
      if (networkIds.has(row.supplierId)) continue;
      if (inquiredSet.has(row.supplierId)) continue;
      if (betterSupplierIds.has(row.supplierId)) continue;
      seenSuppliers.add(row.supplierId);
      newSuppliers.push({
        supplier: {
          id: row.supplierId,
          slug: row.supplierSlug,
          name: row.supplierName,
          city: row.supplierCity,
          isVerified: row.supplierVerified,
        },
        score: row.score,
        goodId: row.goodId,
        goodName: row.goodName,
        unit: row.unit,
        priceMinor: row.priceMinor,
        currency: row.currency,
        minOrder: row.minOrder,
        myVolume: volumeByGood.get(row.goodId) ?? null,
        proximity: proximity(buyerGeo, { city: row.supplierCity }),
      });
      if (newSuppliers.length >= 3) break;
    }

    // ۳) جایگزین — کالای هم‌دسته (هم‌واحد) با قیمت پایین‌تر از تابلوی کالای من
    const alternatives: {
      goodId: string;
      goodName: string;
      unit: string;
      variantLabel: string | null;
      listingId: string;
      priceMinor: number;
      currency: string | null;
      minOrder: number | null;
      supplier: { id: string; slug: string; name: string; city: string; isVerified: boolean };
      watchedGoodId: string;
      watchedGoodName: string;
      proximity: string;
    }[] = [];
    const catIds = [...new Set(goods.map((g) => g.categoryId).filter((c): c is string => !!c))];
    if (catIds.length > 0) {
      const siblingSupply = await this.prisma.listing.findMany({
        where: {
          good: { categoryId: { in: catIds }, id: { notIn: myGoodIds } },
          businessId: { not: business.id },
          isActive: true,
          mode: { in: ["SELL", "BOTH"] },
          priceMinor: { not: null },
        },
        select: {
          id: true,
          goodId: true,
          priceMinor: true,
          currency: true,
          minOrder: true,
          variantLabel: true,
          good: { select: { id: true, nameFa: true, unit: true, categoryId: true } },
          business: { select: { id: true, slug: true, name: true, city: true, isVerified: true, province: true, country: true } },
        },
        orderBy: { priceMinor: "asc" },
        take: 200,
      });
      // برای هر کالای من: ارزان‌ترین کالای خواهری هم‌واحد که از تابلویم ارزان‌تر باشد
      // (مقایسه per-base — بسته‌بندی‌های متفاوت منصفانه مقایسه می‌شوند)
      const usedGoods = new Set<string>();
      for (const gid of myGoodIds) {
        const my = goodById.get(gid);
        if (!my || !my.categoryId) continue;
        const board = supplyByGood.get(gid) ?? [];
        if (board.length === 0) continue;
        const boardCheapest = Math.min(...board.map(perBase));
        const cheaper = siblingSupply
          .filter((s) => s.good.unit === my.unit && s.good.categoryId === my.categoryId)
          .filter((s) => perBase(s) < boardCheapest && !usedGoods.has(s.goodId))
          .sort((a, b) => perBase(a) - perBase(b));
        const pick = cheaper[0];
        if (!pick) continue;
        usedGoods.add(pick.goodId);
        alternatives.push({
          goodId: pick.goodId,
          goodName: pick.good.nameFa,
          unit: pick.good.unit,
          variantLabel: pick.variantLabel,
          listingId: pick.id,
          priceMinor: pick.priceMinor as number,
          currency: pick.currency,
          minOrder: pick.minOrder,
          supplier: pick.business,
          watchedGoodId: gid,
          watchedGoodName: my.nameFa,
          proximity: proximity(buyerGeo, pick.business),
        });
        if (alternatives.length >= 3) break;
      }
    }

    return { betterPrices, newSuppliers, alternatives };
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
      create: { followerPageId, supplierPageId: buyerPageId, source: body.source ?? "ORGANIC" },
      update: existed ? {} : { source: body.source ?? "ORGANIC" },
    });
    // فقط فالوی تازه اعلان دارد — تکرار ساکت می‌ماند
    if (!existed && buyer.ownerId) {
      await this.notifications.push({
        userId: buyer.ownerId,
        // فاز ۸ — گیتِ «اتصال‌های تازه iMach» از notifPrefs
        bizId: buyer.id,
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

    // طرح ۸ (U63) — «گوش به زنگ» بودن یعنی گیت رفع شده: نیازِ منتشرشدهٔ
    // خریداری که صفحه SELL من او را دنبال می‌کند، خودش دعوت است. فقط
    // خریدارِ ناشناسِ بازار پشت گیت ۱۰ معرف می‌ماند.
    const mySellPageId = await ensurePage(this.prisma, business.id, "SELL");
    const watching = await this.prisma.follow.findUnique({
      where: {
        followerPageId_supplierPageId: {
          followerPageId: mySellPageId,
          supplierPageId: await ensurePage(this.prisma, need.businessId, "BUY"),
        },
      },
      select: { id: true },
    });
    if (!watching) {
      // M7 (§۴.۴) — گیتِ شبکهٔ باز (جایگزین گیت ۱۰-معرف): پیشنهاد مستقیم به
      // خریدارِ ناشناس، موتور است — فقط فروشندهٔ ۱۰۰+ آن را باز می‌بیند.
      await this.assertNetworkOpen(business.id, "sell");
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
        payTerm: body.payTerm?.trim() || null,
        delivTerm: body.delivTerm?.trim() || null,
      },
      include: OFFER_INCLUDE,
    });

    // خریدار باید بداند پیشنهاد تازه نشسته — فوراً، نه دفعه‌ی بعد که پنل را باز کرد
    const buyerOwner = await this.prisma.business.findUnique({
      where: { id: need.businessId },
      select: { id: true, ownerId: true },
    });
    if (buyerOwner?.ownerId) {
      await this.notifications.push({
        userId: buyerOwner.ownerId,
        // فاز ۸ — گیتِ «درخواست‌ها و پاسخ‌های قیمت» از notifPrefs
        bizId: buyerOwner.id,
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

  /**
   * Seller answers an inquiry with a concrete price → becomes an Offer for the buyer.
   *
   * M4 (FD-24) — چندقلمی:
   *   · prices[] هم‌ترتیب با Inquiry.items؛ null = «این قلم را نمی‌دارد»
   *     (پیشنهاد ناقص مجاز است). قلمِ بدون آگهیِ فروشنده باید null بماند (حریم).
   *   · priceMinor (legacy) = اولین قیمت غیر-null — سازگاری رندرهای قدیمی.
   *   · شرایط ساختاریافته pay {chk, days} / dlv {ship, by} ذخیره می‌شود و
   *     متنِ معادل آن (payTerm/delivTerm) هم‌زمان ساخته می‌شود تا کلاینت‌های
   *     قدیمی هم بخوانند — «یک زبان، دو سو» (بازتاب زندهٔ فرم ۱۲).
   *   · مهلت: استعلامِ بسته/متوقف/منقضی پاسخ نمی‌گیرد (lazy EXPIRD در خواندن).
   */
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
          select: {
            id: true,
            goodId: true,
            minOrder: true,
            priceMinor: true,
            currency: true,
            good: { select: { nameFa: true } },
          },
        },
      },
    });
    if (!inquiry) throw AppError.notFound("Inquiry not found");
    await assertBusinessOwner(this.prisma, user, inquiry.sellerId, locale);

    // M4 — مهلت و چرخه: بعد از بستن/انقضا پاسخ معتبر نیست
    if (inquiry.closedAt || inquiry.stoppedAt) {
      throw AppError.badRequest("این استعلام بسته شده است", "RFQ_CLOSED");
    }
    if (inquiry.expiresAt && inquiry.expiresAt.getTime() < Date.now()) {
      throw AppError.badRequest("مهلت این درخواست گذشته است", "RFQ_EXPIRED");
    }

    // M4 — اقلام + قیمت‌ها (هم‌ترتیب؛ null = ندارد)
    const items = rfqItemsOf(inquiry);
    let prices: Array<number | null> | null = null;
    if (body.prices && body.prices.length > 0) {
      if (body.prices.length !== items.length) {
        throw AppError.badRequest("تعداد قیمت‌ها با اقلام استعلام نمی‌خواند", "PRICE_MISMATCH");
      }
      prices = body.prices.map((p, i) => {
        if (p == null) return null;
        if (!items[i].listingId) {
          // حریم سبد خریدار — قلمی که فروشنده ندارد را نمی‌تواند قیمت بدهد
          throw AppError.badRequest("قلمی که در کاتالوگ نداری را قیمت نده", "ITEM_NOT_MINE");
        }
        return clampInt(p, 1, 1e12, 1);
      });
      if (prices.every((p) => p == null)) {
        throw AppError.badRequest("حداقل یک قیمت لازم است", "NO_PRICE");
      }
    }
    const firstPrice = prices?.find((p): p is number => p != null) ?? body.priceMinor;
    if (!firstPrice) throw AppError.badRequest("قیمت پیشنهادی لازم است", "NO_PRICE");

    // M4 — شرایط ساختاریافته + متنِ هم‌گام (legacy)
    const pay = body.pay
      ? { chk: clampInt(body.pay.chk, 0, 99, 0), days: clampInt(body.pay.days, 1, 365, 30) }
      : null;
    const dlv = body.dlv
      ? { ship: !!body.dlv.ship, by: body.dlv.by === "customer" ? "customer" : "seller" }
      : null;
    const payTerm =
      pay
        ? pay.chk > 0
          ? `${100 - pay.chk}٪ نقدی + ${pay.chk}٪ چک (تا ${pay.days} روز)`
          : "نقدی"
        : body.payTerm?.trim() || null;
    const delivTerm =
      dlv
        ? dlv.ship
          ? `ارسال — حمل با ${dlv.by === "customer" ? "مشتری" : "فروشنده"}`
          : "تحویل حضوری"
        : body.delivTerm?.trim() || null;

    const offer = await this.prisma.offer.create({
      data: {
        buyerId: inquiry.buyerId,
        sellerId: inquiry.sellerId,
        listingId: inquiry.listingId,
        priceMinor: firstPrice,
        currency: inquiry.listing.currency ?? "IRR",
        minOrder: inquiry.listing.minOrder ?? 0,
        score: 0, // manual answer — no engine score
        isSpecial: false,
        note: body.note?.trim() || null,
        payTerm,
        delivTerm,
        rfqGroupId: inquiry.rfqGroupId ?? null,
        prices,
        pay,
        dlv,
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
        // فاز ۸ — گیتِ «درخواست‌ها و پاسخ‌های قیمت» از notifPrefs
        bizId: buyerBiz.id,
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

  /**
   * Inquiries received by a seller (۱۱ — درخواست‌های قیمت).
   * M4 — چندقلمی:
   *   · items = فقط قلم‌هایی که «این فروشنده» دارد (حریم سبد خریدار) با
   *     قیمت/بستهٔ آگهی خودش برای pre-fill فرم ۱۲ («کاتالوک تو: X»).
   *   · itemsTotal = n کل قلم‌های استعلام (بج «k از n قلم»).
   *   · daysLeft از expiresAt سروری؛ displayStatus: CLOSED | STOPPED |
   *     EXPIRED (lazy) | ANSWERED | NEW | ARCHIVED.
   */
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

    // ── M4 — شکل‌دهی چندقلمی + حریم سبد خریدار ──
    const allItems = rows.map((r) => rfqItemsOf(r));
    const goodIds = [...new Set(allItems.flat().map((it) => it.goodId))].filter(Boolean);
    const myListingIds = [...new Set(allItems.flat().map((it) => it.listingId).filter((x): x is string => !!x))];
    const [goods, myListings] = await Promise.all([
      goodIds.length
        ? this.prisma.good.findMany({
            where: { id: { in: goodIds } },
            select: { id: true, nameFa: true, nameEn: true, unit: true },
          })
        : [],
      myListingIds.length
        ? this.prisma.listing.findMany({
            where: { id: { in: myListingIds } },
            select: {
              id: true, priceMinor: true, currency: true, variantLabel: true,
              baseQty: true, packaging: true, pricePerBaseMinor: true, goodId: true,
            },
          })
        : [],
    ]);
    const goodById = new Map(goods.map((g) => [g.id, g]));
    const listingById = new Map(myListings.map((l) => [l.id, l]));
    const now = Date.now();

    const shaped = rows.map((r, idx) => {
      const items = allItems[idx];
      const mine = items.filter((it) => it.listingId); // حریم: فقط قلم‌های خودم
      return {
        ...r,
        items: mine.map((it) => {
          const l = it.listingId ? listingById.get(it.listingId) : undefined;
          return {
            goodId: it.goodId,
            qty: it.qty,
            listingId: it.listingId,
            listing: l
              ? {
                  id: l.id, priceMinor: l.priceMinor, currency: l.currency,
                  variantLabel: l.variantLabel, baseQty: l.baseQty,
                  packaging: l.packaging, pricePerBaseMinor: l.pricePerBaseMinor,
                }
              : null,
            good: goodById.get(it.goodId) ?? null,
          };
        }),
        itemsTotal: items.length,
        myCover: mine.length,
        daysLeft: r.expiresAt ? Math.max(0, Math.ceil((r.expiresAt.getTime() - now) / DAY_MS)) : null,
        displayStatus: r.closedAt
          ? "CLOSED"
          : r.stoppedAt
            ? "STOPPED"
            : r.expiresAt && r.expiresAt.getTime() < now
              ? "EXPIRED"
              : r.status,
      };
    });
    return { ...toPage(shaped, cap), unreadCount: unread };
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

  // ═══ M4 — چرخهٔ گروهی استعلام (۲۴/۲۶/۲۷) + پذیرش پیشنهاد ═══

  /** گروه‌های استعلام خریدار را با مالکیت چک می‌کند — ردیف نمونه برمی‌گرداند.
   *  گروه = rfqGroupId مشترک (UUID)؛ legacy = id خودِ استعلام تک‌ردیفی (ObjectId).
   *  ⚠ نه isObjectId بگیر نه id خالی — groupWhere هر دو شکل را امن می‌پوشاند. */
  private async rfqGroupOf(
    businessId: string,
    groupId: string,
    locale: Locale,
    user: AuthUser
  ) {
    const sample = await this.prisma.inquiry.findFirst({
      where: groupWhere(groupId),
      orderBy: { createdAt: "asc" },
    });
    if (!sample) throw AppError.notFound("RFQ not found");
    await assertBusinessOwner(this.prisma, user, sample.buyerId, locale);
    if (sample.buyerId !== businessId) {
      // ردیف اول ممکن است مالِ خریدار دیگری باشد (id تصادفی) — چک دقیق‌تر
      const mine = await this.prisma.inquiry.findFirst({
        where: { buyerId: businessId, ...groupWhere(groupId) },
      });
      if (!mine) throw AppError.notFound("RFQ not found");
      return { id: groupId, sample: mine };
    }
    return { id: sample.rfqGroupId ?? sample.id, sample };
  }

  /** M4 (N9) — خریدار استعلام باز را می‌بندد («بستن این استعلام» ۲۶) بدون پذیرش. */
  @Post("stopRfq/:groupId")
  async stopRfq(
    @Param("groupId") groupId: string,
    @Body() body: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const { id } = await this.rfqGroupOf(body.businessId, groupId, locale, user);
    await this.prisma.inquiry.updateMany({
      where: groupWhere(id),
      data: { stoppedAt: new Date(), closedAt: null, resultText: null },
    });
    this.invalidateBuyerSide(body.businessId);
    return { ok: true };
  }

  /** M4 (N9) — بازکردن استعلامِ متوقف‌شده (پذیرفته‌شده دوباره باز نمی‌شود). */
  @Post("restartRfq/:groupId")
  async restartRfq(
    @Param("groupId") groupId: string,
    @Body() body: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const { id, sample } = await this.rfqGroupOf(body.businessId, groupId, locale, user);
    if (sample.closedAt) {
      throw AppError.badRequest("استعلام پذیرفته‌شده دوباره باز نمی‌شود", "RFQ_ACCEPTED");
    }
    await this.prisma.inquiry.updateMany({
      where: groupWhere(id),
      data: { stoppedAt: null, closedAt: null, resultText: null },
    });
    this.invalidateBuyerSide(body.businessId);
    return { ok: true };
  }

  /** M4 (N9) — بایگانی گروه: از فهرست خریدار می‌افتد؛ تاریخچه دست‌نخورده. */
  @Post("archiveRfq/:groupId")
  async archiveRfq(
    @Param("groupId") groupId: string,
    @Body() body: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const { id } = await this.rfqGroupOf(body.businessId, groupId, locale, user);
    await this.prisma.inquiry.updateMany({
      where: groupWhere(id),
      data: { status: "ARCHIVED", isRead: true },
    });
    this.invalidateBuyerSide(body.businessId);
    return { ok: true };
  }

  /** M4 (N9) — «تکرار درخواست»: کلون سبد با گیرندگانِ تازه (refresh اجتماع دارندگان)
   *  + مهلت تازه (پیش‌فرض ۳ روز). سبد/یادداشت/قیمت هدف کپی می‌شوند. */
  @Post("repeatRfq/:groupId")
  @HttpCode(HttpStatus.CREATED)
  async repeatRfq(
    @Param("groupId") groupId: string,
    @Body() body: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    const { sample } = await this.rfqGroupOf(body.businessId, groupId, locale, user);
    const src = await this.prisma.inquiry.findFirst({
      where: groupWhere(groupId),
      include: { listing: { select: { goodId: true } } },
      orderBy: { createdAt: "asc" },
    });
    if (!src) throw AppError.notFound("RFQ not found");
    const basket = rfqItemsOf(src).map((it) => ({ goodId: it.goodId, qty: it.qty }));
    if (basket.length === 0) throw AppError.badRequest("سبد خالی است", "EMPTY_BASKET");

    // refresh دارندگان — همان رزولوشن requestQuote (اجتماع + مرتب پوشش)
    const listingRows = await this.prisma.listing.findMany({
      where: {
        goodId: { in: basket.map((b) => b.goodId) },
        isActive: true,
        mode: { in: ["SELL", "BOTH"] },
        businessId: { not: business.id },
      },
      select: { id: true, businessId: true, goodId: true, priceMinor: true },
      orderBy: { priceMinor: "asc" },
    });
    const perSeller = new Map<string, Map<string, string>>();
    for (const r of listingRows) {
      let m = perSeller.get(r.businessId);
      if (!m) {
        m = new Map();
        perSeller.set(r.businessId, m);
      }
      if (!m.has(r.goodId)) m.set(r.goodId, r.id);
    }
    if (perSeller.size === 0) {
      throw AppError.badRequest("هیچ تأمین‌کننده‌ای این کالاها را ندارد", "NO_HOLDER");
    }
    const minCover = (m: Map<string, string>) => m.size;
    const sellers = [...perSeller.entries()].sort((a, b) => minCover(b[1]) - minCover(a[1])).slice(0, 15);

    const rfqGroupId = randomUUID();
    const expiresAt = new Date(Date.now() + 3 * DAY_MS);
    const created = await this.prisma.$transaction(
      async (tx) => {
        const rows = [];
        for (const [sellerId, m] of sellers) {
          const items = basket.map((b) => ({
            goodId: b.goodId,
            qty: b.qty,
            listingId: m.get(b.goodId) ?? null,
          }));
          const firstCovered = items.find((it) => it.listingId);
          if (!firstCovered) continue;
          rows.push(
            await tx.inquiry.create({
              data: {
                buyerId: business.id,
                sellerId,
                listingId: firstCovered.listingId as string,
                volume: basket[0].qty,
                note: src.note,
                frequency: src.frequency,
                delivery: src.delivery,
                deliveryCity: src.deliveryCity,
                targetPriceMinor: src.targetPriceMinor,
                rfqGroupId,
                items,
                expiresAt,
              },
            })
          );
        }
        return rows;
      },
      { timeout: 30_000, maxWait: 10_000 }
    );

    // اعلان به فروشنده‌های تازه
    const owners = await this.prisma.business.findMany({
      where: { id: { in: [...perSeller.keys()] }, ownerId: { not: null } },
      select: { id: true, ownerId: true },
    });
    const firstGood = await this.prisma.good.findUnique({
      where: { id: basket[0].goodId },
      select: { nameFa: true },
    });
    const goodLabel =
      basket.length > 1 ? `${firstGood?.nameFa ?? ""} +${basket.length - 1} قلم دیگر` : (firstGood?.nameFa ?? "");
    await this.notifications.pushMany(
      owners.map((s) => ({
        userId: s.ownerId as string,
        bizId: s.id,
        type: "QUOTE" as const,
        actorId: business.id,
        actorName: business.name,
        actorSlug: business.slug,
        good: goodLabel,
      }))
    );

    this.invalidateBuyerSide(business.id);
    return { ok: true, groupId: rfqGroupId, created: created.length };
  }

  /**
   * M4 — پذیرش پیشنهاد (۲۷): استعلام می‌بندد (همهٔ ردیف‌های گروه) +
   * resultText («پذیرفت: فروشنده — جمع X تومان») + اعلان به فروشندهٔ برنده.
   * سفارش‌سازی در M5 وصل می‌شود؛ items/total برای کال‌اوت «ثبت سفارش»
   * برمی‌گردد (snapshot قلم‌های قیمت‌خورده — جنس همان offerOrderCreate).
   */
  @Post("acceptOffer/:id")
  async acceptOffer(
    @Param("id") offerId: string,
    @Body() body: AcceptOfferDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    if (!isObjectId(offerId)) throw AppError.notFound("Offer not found");
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
      include: {
        seller: { select: { id: true, name: true, slug: true, ownerId: true } },
        listing: { select: { good: { select: { nameFa: true } } } },
      },
    });
    if (!offer) throw AppError.notFound("Offer not found");
    await assertBusinessOwner(this.prisma, user, offer.buyerId, locale);
    if (offer.buyerId !== body.businessId) throw AppError.notFound("Offer not found");

    // گروه استعلام این پیشنهاد — پیوند مستقیم یا هیوریستیک legacy
    let groupId: string | null = offer.rfqGroupId;
    if (!groupId) {
      const legacy = await this.prisma.inquiry.findFirst({
        where: {
          listingId: offer.listingId,
          sellerId: offer.sellerId,
          buyerId: offer.buyerId,
          createdAt: { lte: offer.createdAt },
        },
        orderBy: { createdAt: "desc" },
        select: { rfqGroupId: true, id: true },
      });
      groupId = legacy?.rfqGroupId ?? legacy?.id ?? null;
    }

    // اقلام + جمع (قلم‌های قیمت‌خورده — جنس offerOrderCreate برای M5)
    let items: Array<{ goodId: string; qty: number; priceMinor: number | null }> = [];
    let totalMinor: number | null = null;
    if (groupId) {
      const inq = await this.prisma.inquiry.findFirst({
        where: groupWhere(groupId),
        include: { listing: { select: { goodId: true } } },
        orderBy: { createdAt: "asc" },
      });
      if (inq) {
        const rfqItems = rfqItemsOf(inq);
        const prices = (Array.isArray(offer.prices) && (offer.prices as unknown[]).length
          ? (offer.prices as Array<number | null>)
          : [offer.priceMinor]
        ).slice(0, rfqItems.length);
        while (prices.length < rfqItems.length) prices.push(null);
        items = rfqItems.map((it, i) => ({
          goodId: it.goodId,
          qty: it.qty,
          priceMinor: prices[i],
        }));
        totalMinor = items.reduce((sum, it) => (it.priceMinor != null ? sum + it.priceMinor * it.qty : sum), 0);
        if (rfqItems.length === 1 && items[0]?.priceMinor != null) totalMinor = items[0].priceMinor * items[0].qty;
      }
    }

    const single = items.length <= 1;
    const amount = single ? offer.priceMinor : (totalMinor ?? offer.priceMinor);
    const resultText = `پذیرفت: ${offer.seller.name} — ${single ? faMoney(amount) : `جمع ${faMoney(amount)}`} ت`;

    if (groupId) {
      await this.prisma.inquiry.updateMany({
        where: groupWhere(groupId),
        // M5 — پیشنهادِ برنده ثبت می‌شود: گارد قطعیِ «ثبت سفارش با همین شرایط»
        data: { closedAt: new Date(), stoppedAt: null, resultText, acceptedOfferId: offer.id },
      });
    }

    // اعلان به فروشندهٔ برنده — مهم‌ترین خبرِ اوست (FD-19)
    if (offer.seller.ownerId) {
      await this.notifications.push({
        userId: offer.seller.ownerId,
        bizId: offer.seller.id,
        type: "OFFER",
        actorId: offer.buyerId,
        good: offer.listing.good.nameFa,
      });
    }

    this.invalidateBuyerSide(offer.buyerId);
    return {
      ok: true,
      resultText,
      totalMinor: totalMinor ?? offer.priceMinor,
      items: items.filter((it) => it.priceMinor != null),
      groupId,
    };
  }

  // ═══ فاز ۵ — دنبال‌کردن قیمت (شکاف ۱) و لیست خرید (طرح ۰۸) ═══

  /** «دنبال کردن قیمت» — خریدار کالا را در لیست/تابلوی خودش می‌نشاند.
   *  آیدی‌پاتنت: upsert؛ دنبال‌کردنِ دوباره بی‌ضرر است.
   *  فاز ۱۲ — supplierId مبدأ: «دنبال کردن کالا (آگهی فروش)» از کاتالوگ/صفحهٔ
   *  محصول یک فروشنده یعنی همان فروشنده به‌طور طبیعی در لیست دنبال‌شده‌های
   *  قیمتِ این کالا بنشیند → Follow خودکار (همان الگوی followSupplier) +
   *  اعلان مشتریِ تازه به فروشنده. رصدِ دوباره آرشیو را هم برمی‌دارد. */
  @Post("watchGood")
  @HttpCode(HttpStatus.CREATED)
  async watchGood(
    @Body() body: WatchGoodDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    if (!isObjectId(body.goodId)) throw AppError.notFound("Good not found");
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    const good = await this.prisma.good.findUnique({ where: { id: body.goodId }, select: { id: true } });
    if (!good) throw AppError.notFound("Good not found");
    const wg = await this.prisma.watchedGood.upsert({
      where: { businessId_goodId: { businessId: body.businessId, goodId: body.goodId } },
      create: { businessId: body.businessId, goodId: body.goodId },
      // دوباره دنبال‌کردنِ کالای آرشیوشده = بازگشت به دفترِ روزمره
      update: { archivedAt: null },
    });

    // ── Follow خودکارِ تامین‌کنندهٔ مبدأ (فاز ۱۲ — شکاف A) ──
    let followed = false;
    if (body.supplierId && isObjectId(body.supplierId) && body.supplierId !== business.id) {
      const supplier = await this.prisma.business.findUnique({
        where: { id: body.supplierId },
        select: { id: true, ownerId: true },
      });
      if (supplier) {
        const followerPageId = await ensurePage(this.prisma, business.id, "BUY");
        const supplierPageId = await ensurePage(this.prisma, supplier.id, "SELL");
        const existed = await this.prisma.follow.findUnique({
          where: { followerPageId_supplierPageId: { followerPageId, supplierPageId } },
          select: { id: true },
        });
        await this.prisma.follow.upsert({
          where: { followerPageId_supplierPageId: { followerPageId, supplierPageId } },
          create: { followerPageId, supplierPageId, source: "ORGANIC" },
          update: {},
        });
        followed = true;
        // فالوی تازه = مشتری جدید — صاحب کاتالوگ باید بداند (best-effort)
        if (!existed && supplier.ownerId) {
          await this.notifications
            .push({
              userId: supplier.ownerId,
              bizId: supplier.id,
              type: "FOLLOW_SUPPLIER",
              actorId: business.id,
              actorName: business.name,
              actorSlug: business.slug,
            })
            .catch(() => false);
        }
      }
    }

    this.cache.invalidateTag(`market:watch:${body.businessId}`);
    this.invalidateBuyerSide(body.businessId);

    // ── M10 (N5) — تاریخچهٔ رویداد کالا: خریدار این کالا را به لیست خریدش
    // افزود — روی همهٔ آگهی‌های فروشِ فعال همان کالا (هر فروشنده ردیف خودش)
    await this.listingEvents.logWatchOnGood(body.goodId, {
      businessId: business.id,
      name: business.name,
    });

    return { ok: true, watched: true, followed, id: wg.id };
  }

  // ═══ M10 (N6 · سند ۰۸ §M10) — گوش-به-زنگ فروشنده (زنگولهٔ لیست خرید عمومی) ═══

  /** روشن‌کردن زنگوله — upsert سه‌تایی (فروشنده × خریدار × کالا).
   *  فعال‌شدنش یعنی: استعلام‌های این خریدار برای این کالا در تب «گوش به زنگ»
   *  میز استعلام فروشنده (11) می‌آید + اعلان BUYER_NEED می‌گیرد. */
  @Post("need-alerts")
  @HttpCode(HttpStatus.CREATED)
  async setNeedAlert(
    @Body() body: NeedAlertDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    if (!isObjectId(body.buyerBusinessId) || !isObjectId(body.goodId)) {
      throw AppError.badRequest("خریدار یا کالا معتبر نیست", "NEED_ALERT_BAD_TARGET");
    }
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    if (body.buyerBusinessId === business.id) {
      throw AppError.badRequest("به نیاز خودتان زنگوله نمی‌خورد", "NEED_ALERT_SELF");
    }
    const [buyer, good] = await Promise.all([
      this.prisma.business.findUnique({ where: { id: body.buyerBusinessId }, select: { id: true, slug: true } }),
      this.prisma.good.findUnique({ where: { id: body.goodId }, select: { id: true, nameFa: true } }),
    ]);
    if (!buyer || !good) throw AppError.notFound("خریدار یا کالا پیدا نشد");
    const row = await this.prisma.needAlert.upsert({
      where: {
        sellerBusinessId_buyerBusinessId_goodId: {
          sellerBusinessId: business.id,
          buyerBusinessId: buyer.id,
          goodId: good.id,
        },
      },
      create: { sellerBusinessId: business.id, buyerBusinessId: buyer.id, goodId: good.id },
      update: {},
    });
    return { id: row.id, on: true, goodId: good.id };
  }

  /** خاموش‌کردن زنگوله — حذف یال سه‌تایی */
  @Delete("need-alerts")
  async unsetNeedAlert(
    @Query() query: NeedAlertQueryDto,
    @Query("goodId") goodId: string,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    if (!isObjectId(goodId)) throw AppError.badRequest("کالا معتبر نیست", "NEED_ALERT_BAD_GOOD");
    await this.prisma.needAlert.deleteMany({
      where: {
        sellerBusinessId: business.id,
        buyerBusinessId: query.buyerBusinessId,
        goodId,
      },
    });
    return { ok: true, on: false, goodId };
  }

  /** وضعیت زنگوله‌های من روی لیست خرید یک خریدار — ردیف‌های /buy/[slug] */
  @Get("need-alerts")
  async myNeedAlerts(
    @Query() query: NeedAlertQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    const rows = await this.prisma.needAlert.findMany({
      where: { sellerBusinessId: business.id, buyerBusinessId: query.buyerBusinessId },
      select: { goodId: true, createdAt: true },
    });
    return { goodIds: rows.map((r) => r.goodId) };
  }

  /** تب «گوش به زنگ» میز استعلام فروشنده (11) — استعلام‌های جاری خریدارانی
   *  که زنگوله‌شان را روشن کرده‌ام (برای همین اقلام). ردیف‌های مستقیم هم
   *  می‌آیند — همان چیزی که فروشنده دنبالش بود، یک‌جا. */
  @Get("watched-buyer-needs")
  async watchedBuyerNeeds(
    @Query() query: WatchedNeedsQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    // یال‌های فعال من: خریدار × کالا
    const alerts = await this.prisma.needAlert.findMany({
      where: { sellerBusinessId: business.id },
      select: { buyerBusinessId: true, goodId: true },
      take: 500,
    });
    if (alerts.length === 0) return { items: [] };

    // استعلام‌های منِ باز (NEW) که خریدارشان زنگوله‌خورش است
    // NOTE: stoppedAt/closedAt در Prisma+Mongo با null-filter به ردیفِ
    // «فیلدغایب» نمی‌چسبد (درس این فاز) — همان جریان getInquiries: خواندن
    // بدون آن فیلترها + بازبینی lazy این‌جا.
    const now = new Date();
    const rows = (
      await this.prisma.inquiry.findMany({
        where: {
          sellerId: business.id,
          status: "NEW",
          buyerId: { in: [...new Set(alerts.map((a) => a.buyerBusinessId))] },
        },
        include: { buyer: { select: { id: true, name: true, slug: true, city: true } } },
        orderBy: { createdAt: "desc" },
        take: 50,
      })
    ).filter(
      // باز = بدون توقف/بسته و مهلتِ نگذشته (missing-field ↔ null در فیلتر
      // پرایسما-مونگو نمی‌چسبد — بازبینی lazy مثل getInquiries)
      (r) =>
        r.stoppedAt === null &&
        r.closedAt === null &&
        (r.expiresAt === null || r.expiresAt.getTime() > now.getTime())
    );

    // فقط ردیف‌هایی که حداقل یکی از اقلامشان زنگوله‌خورش است
    const alertPairs = new Set(alerts.map((a) => `${a.buyerBusinessId}:${a.goodId}`));
    const goodIds = [
      ...new Set(
        rows.flatMap((r) => ((r.items as { goodId: string }[] | null) ?? []).map((it) => it.goodId))
      ),
    ];
    const goods = goodIds.length
      ? await this.prisma.good.findMany({
          where: { id: { in: goodIds } },
          select: { id: true, nameFa: true, nameEn: true, unit: true },
        })
      : [];
    const goodById = new Map(goods.map((g) => [g.id, g]));

    const items = rows
      .map((r) => {
        const basket = (r.items as { goodId: string; qty: number; listingId: string | null }[] | null) ?? [];
        const watchedGoods = basket.filter((it) => alertPairs.has(`${r.buyerId}:${it.goodId}`));
        if (watchedGoods.length === 0) return null;
        return {
          id: r.id,
          buyer: r.buyer,
          goods: basket.map((it) => goodById.get(it.goodId) ?? null),
          itemsTotal: basket.length,
          watchedCount: watchedGoods.length,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          daysLeft: r.expiresAt
            ? Math.max(0, Math.ceil((r.expiresAt.getTime() - now.getTime()) / DAY_MS))
            : null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return { items };
  }

  /** فاز ۱۲ — آرشیو موقتِ ردیف دفتر خرید: «از دفترِ روزمره کنار می‌رود؛
   *  رصد و تاریخچهٔ قیمت می‌ماند». BUY listing هم غیرفعال می‌شود تا از
   *  لیست عمومی/جست‌وجو کنار برود؛ بازگردانی (archived=false) هر دو را برمی‌گرداند. */
  @Post("archiveWatchedGood")
  async archiveWatchedGood(
    @Body() body: ArchiveWatchedGoodDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    if (!isObjectId(body.goodId)) throw AppError.notFound("Good not found");
    await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    const listing = await this.prisma.listing.findFirst({
      where: { businessId: body.businessId, goodId: body.goodId, mode: { in: ["BUY", "BOTH"] } },
      select: { id: true },
    });
    if (listing) {
      await this.prisma.listing.update({
        where: { id: listing.id },
        data: { isActive: body.archived ? false : true },
        select: { id: true },
      });
    }
    if (body.archived) {
      // نشانِ آرشیو فقط روی WatchedGood می‌نشیند (اگر هست)؛ BUY listingِ
      // غیرفعالشده خودش از دفتر می‌افتد و بازگردانی‌اش از همین endpoint است.
      await this.prisma.watchedGood.updateMany({
        where: { businessId: body.businessId, goodId: body.goodId },
        data: { archivedAt: new Date() },
      });
    } else {
      await this.prisma.watchedGood.updateMany({
        where: { businessId: body.businessId, goodId: body.goodId },
        data: { archivedAt: null },
      });
    }
    this.cache.invalidateTag(`market:watch:${body.businessId}`);
    this.invalidateBuyerSide(body.businessId);
    return { ok: true, archived: body.archived };
  }

  /** M3 مهاجرت (سند ۰۸ §۷) — پرچم «در حال اتمام موجودی» (۲۰ج):
   *  toggle روی WatchedGood.lowStock. کالایی که فقط با BUY listing در
   *  لیست است (بدون ردیف WatchedGood) با upsert ردیف می‌گیرد تا پرچم
   *  جا بگیرد؛ حذف پرچم (false) ردیف را حذف نمی‌کند — «حذف آیتم» همان
   *  × آرامِ فرم است، ردیف در لیست خرید می‌ماند (سادگی همیشگی). */
  @Post("setLowStock")
  async setLowStock(
    @Body() body: SetLowStockDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    if (!isObjectId(body.goodId)) throw AppError.notFound("Good not found");
    await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    const wg = await this.prisma.watchedGood.upsert({
      where: { businessId_goodId: { businessId: body.businessId, goodId: body.goodId } },
      create: { businessId: body.businessId, goodId: body.goodId, lowStock: body.lowStock },
      update: { lowStock: body.lowStock },
      select: { id: true, lowStock: true },
    });
    this.cache.invalidateTag(`market:watch:${body.businessId}`);
    this.invalidateBuyerSide(body.businessId);
    return { ok: true, lowStock: wg.lowStock };
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
    this.invalidateBuyerSide(body.businessId);
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
    @Query("archived") archived: string | undefined,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    await assertBusinessOwner(this.prisma, user, query.businessId, locale);

    // فاز ۱۲ — نمای آرشیو: فقط ردیف‌های آرشیوشده (WatchedGood.archivedAt)،
    // با حجم/دورهٔ listing غیرفعال‌شده. فیلتر آرشیو در JS انجام می‌شود —
    // فیلتر null روی فیلدِ غایب در MongoDB (Prisma) مطابقت نمی‌دهد.
    const archivedView = archived === "true";
    const [buyListings, watchedAll] = await Promise.all([
      this.prisma.listing.findMany({
        where: {
          businessId: query.businessId,
          mode: { in: ["BUY", "BOTH"] },
          ...(archivedView ? {} : { isActive: true }),
        },
        select: { id: true, goodId: true, volume: true, frequency: true, variantLabel: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.watchedGood.findMany({
        where: { businessId: query.businessId },
        select: { goodId: true, createdAt: true, lastNotifiedAt: true, archivedAt: true, lowStock: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    const watched = archivedView
      ? watchedAll.filter((w) => w.archivedAt)
      : watchedAll.filter((w) => !w.archivedAt);

    const goodIds = archivedView
      ? [...new Set(watched.map((w) => w.goodId))]
      : [...new Set([...buyListings.map((l) => l.goodId), ...watched.map((w) => w.goodId)])];
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
        archivedAt: watch?.archivedAt ?? null,
        // M3 — پرچم «در حال اتمام موجودی» (۲۰ج)؛ ردیفِ فقط-BUY = false
        lowStock: watch?.lowStock ?? false,
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
   * GET /market/getMyRfqs (فاز ۴ مهاجرت · sc-offers) — استعلام‌های گروهی خریدار.
   * M4 — چندقلمی (FD-24):
   *   · گروه = rfqGroupId مشترک (legacy: id استعلام تک‌ردیفی؛ سرد: c+offerId).
   *   · items = سبد کامل [{goodId, qty, good}] — بدون حریم (مالکِ سبد خودِ خریدار است).
   *   · recipients با coverage «k از n قلم» (k = قلم‌هایی که آن فروشنده دارد).
   *   · offers با prices[] (default [priceMinor]) + pay/dlv ساختاریافته +
   *     cover/totalMinor محاسبه‌شده سمت سرور (مرتب‌سازی ۲۶: پوشش اول، بعد جمع).
   *   · status lazy: CLOSED (closedAt) | STOPPED (stoppedAt) | EXPIRED
   *     (expiresAt گذشته) | ARCHIVED (همهٔ ردیف‌ها آرشیو) | OPEN.
   *   · پیوند پیشنهاد→گروه: rfqGroupId مستقیم؛ legacy با هیوریستیک
   *     listing:seller + قید زمانی؛ سرد (offerBuyRequest) = گروه COLD.
   */
  @Get("getMyRfqs")
  async getMyRfqs(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);

    const [inquiries, offers] = await Promise.all([
      this.prisma.inquiry.findMany({
        where: { buyerId: business.id },
        include: {
          listing: {
            select: {
              id: true,
              goodId: true,
              good: {
                select: {
                  id: true, nameFa: true, nameEn: true, unit: true,
                  category: { select: { slug: true, nameFa: true } },
                },
              },
            },
          },
          seller: { select: { id: true, slug: true, name: true, city: true, isVerified: true, phone: true } },
        },
        orderBy: { createdAt: "asc" },
        take: 200,
      }),
      this.prisma.offer.findMany({
        where: { buyerId: business.id },
        include: {
          seller: { select: { id: true, slug: true, name: true, city: true, isVerified: true, phone: true } },
          listing: { select: { good: { select: { id: true, nameFa: true, nameEn: true, unit: true } } } },
        },
        orderBy: { createdAt: "asc" },
        take: 500,
      }),
    ]);

    // ── گروه‌بندی استعلام‌ها (rfqGroupId · legacy: id) ──
    type Group = {
      id: string;
      kind: "RFQ" | "COLD";
      createdAt: Date;
      items: RfqItem[];
      volume: number | null;
      frequency: string | null;
      delivery: string | null;
      deliveryCity: string | null;
      targetPriceMinor: number | null;
      note: string | null;
      expiresAt: Date | null;
      stoppedAt: Date | null;
      closedAt: Date | null;
      resultText: string | null;
      archived: boolean;
      recipients: Array<{
        inquiryId: string;
        sellerId: string;
        status: string;
        coverage: number;
        answered: boolean;
        seller: { id: string; slug: string; name: string; city: string | null; isVerified: boolean; phone: string | null };
      }>;
      offers: Array<Record<string, unknown>>;
      offerCount: number;
      markedCount: number;
      minPriceMinor: number | null;
    };
    const groups = new Map<string, Group>();
    const groupOf = (inq: (typeof inquiries)[number]): Group => {
      const id = inq.rfqGroupId ?? inq.id;
      let g = groups.get(id);
      if (!g) {
        g = {
          id,
          kind: "RFQ",
          createdAt: inq.createdAt,
          items: rfqItemsOf(inq),
          volume: inq.volume,
          frequency: inq.frequency,
          delivery: inq.delivery,
          deliveryCity: inq.deliveryCity,
          targetPriceMinor: inq.targetPriceMinor,
          note: inq.note,
          expiresAt: inq.expiresAt,
          stoppedAt: inq.stoppedAt,
          closedAt: inq.closedAt,
          resultText: inq.resultText,
          archived: true,
          recipients: [],
          offers: [],
          offerCount: 0,
          markedCount: 0,
          minPriceMinor: null,
        };
        groups.set(id, g);
      }
      return g;
    };
    for (const inq of inquiries) {
      const g = groupOf(inq);
      g.createdAt = inq.createdAt > g.createdAt ? inq.createdAt : g.createdAt; // جدیدترین ردیف = زمان ارسال
      g.archived = g.archived && inq.status === "ARCHIVED"; // فقط اگر «همهٔ» ردیف‌ها آرشیو باشند
      g.recipients.push({
        inquiryId: inq.id,
        sellerId: inq.sellerId,
        status: inq.status,
        coverage: rfqItemsOf(inq).filter((it) => it.listingId).length,
        answered: inq.status === "ANSWERED",
        seller: inq.seller,
      });
    }

    // ── پیوند پیشنهاد→گروه: مستقیم · legacy هیوریستیک · سرد ──
    const byKey = new Map<string, typeof inquiries>();
    for (const inq of inquiries) {
      const k = `${inq.listingId}:${inq.sellerId}`;
      const list = byKey.get(k) ?? [];
      list.push(inq);
      byKey.set(k, list);
    }
    const offerGroup = new Map<string, Group>();
    for (const o of offers) {
      let g: Group | undefined = o.rfqGroupId ? groups.get(o.rfqGroupId) : undefined;
      if (!g) {
        // legacy — جدیدترین استعلام همان جفت که قبل از پیشنهاد ساخته شده
        const list = byKey.get(`${o.listingId}:${o.sellerId}`);
        if (list) {
          let target: (typeof inquiries)[number] | null = null;
          for (const inq of list) if (inq.createdAt <= o.createdAt) target = inq;
          if (target) g = groups.get(target.rfqGroupId ?? target.id);
        }
      }
      if (g) offerGroup.set(o.id, g);
    }

    const now = Date.now();
    let recentOfferCount = 0;
    for (const o of offers) {
      if (now - o.createdAt.getTime() < 72 * 3_600_000) recentOfferCount++;
      const g = offerGroup.get(o.id);
      if (g) {
        const prices: Array<number | null> = (
          Array.isArray(o.prices) && (o.prices as unknown[]).length
            ? (o.prices as Array<number | null>)
            : [o.priceMinor]
        ).slice(0, g.items.length);
        while (prices.length < g.items.length) prices.push(null);
        const cover = prices.filter((p): p is number => p != null).length;
        const totalMinor =
          g.items.length > 1
            ? g.items.reduce((sum, it, i) => (prices[i] != null ? sum + (prices[i] as number) * it.qty : sum), 0)
            : (prices[0] ?? o.priceMinor) * (g.items[0]?.qty ?? 0);
        g.offers.push({
          id: o.id,
          sellerId: o.sellerId,
          listingId: o.listingId,
          seller: o.seller,
          priceMinor: o.priceMinor,
          currency: o.currency,
          minOrder: o.minOrder,
          payTerm: o.payTerm,
          delivTerm: o.delivTerm,
          pay: o.pay,
          dlv: o.dlv,
          prices,
          cover,
          totalMinor,
          note: o.note,
          status: o.status,
          createdAt: o.createdAt,
        });
        g.offerCount++;
        if (o.status) g.markedCount++;
        g.minPriceMinor =
          g.minPriceMinor === null ? o.priceMinor : Math.min(g.minPriceMinor, o.priceMinor);
        continue;
      }

      // سرد — گروه مستقل per پیشنهاد (حجمِ BUY listing خودم در همان کالا)
      const cg: Group = {
        id: `c${o.id}`,
        kind: "COLD",
        createdAt: o.createdAt,
        items: o.listing.good
          ? [{ goodId: o.listing.good.id, qty: 0, listingId: o.listingId }]
          : [],
        volume: null,
        frequency: null,
        delivery: null,
        deliveryCity: business.city,
        targetPriceMinor: null,
        note: null,
        expiresAt: null,
        stoppedAt: null,
        closedAt: null,
        resultText: null,
        archived: false,
        recipients: [],
        offers: [
          {
            id: o.id,
            sellerId: o.sellerId,
            listingId: o.listingId,
            seller: o.seller,
            priceMinor: o.priceMinor,
            currency: o.currency,
            minOrder: o.minOrder,
            payTerm: o.payTerm,
            delivTerm: o.delivTerm,
            pay: o.pay,
            dlv: o.dlv,
            prices: [o.priceMinor],
            cover: 1,
            totalMinor: o.priceMinor,
            note: o.note,
            status: o.status,
            createdAt: o.createdAt,
          },
        ],
        offerCount: 1,
        markedCount: o.status ? 1 : 0,
        minPriceMinor: o.priceMinor,
      };
      groups.set(cg.id, cg);
    }

    // ── حجم استعلام‌های سرد از BUY listing خودم ──
    const coldGroups = [...groups.values()].filter((g) => g.kind === "COLD" && g.items[0]);
    if (coldGroups.length > 0) {
      const coldGoodIds = [...new Set(coldGroups.map((g) => g.items[0]!.goodId))];
      const myBuyRows = await this.prisma.listing.findMany({
        where: { businessId: business.id, goodId: { in: coldGoodIds }, isActive: true, mode: { in: ["BUY", "BOTH"] } },
        select: { goodId: true, volume: true, frequency: true },
        orderBy: { updatedAt: "desc" },
      });
      const vol = new Map(myBuyRows.map((r) => [r.goodId, r]));
      for (const g of coldGroups) {
        const v = vol.get(g.items[0]!.goodId);
        if (v) {
          g.volume = v.volume;
          g.frequency = v.frequency;
          if (g.items[0]) g.items[0].qty = v.volume ?? 0;
        }
      }
    }

    // ── اطلاعات کالا برای اقلام همهٔ گروه‌ها ──
    const goodIds = [...new Set([...groups.values()].flatMap((g) => g.items.map((it) => it.goodId)))].filter(Boolean);
    const goods = goodIds.length
      ? await this.prisma.good.findMany({
          where: { id: { in: goodIds } },
          select: { id: true, nameFa: true, nameEn: true, unit: true, category: { select: { slug: true, nameFa: true } } },
        })
      : [];
    const goodById = new Map(goods.map((g) => [g.id, g]));

    const list = [...groups.values()]
      .filter((g) => !g.archived) // آرشیو شده = از فهرست خریدار می‌افتد
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((g) => {
        const items = g.items.map((it) => ({
          goodId: it.goodId,
          qty: it.qty,
          good: goodById.get(it.goodId) ?? null,
        }));
        const status =
          g.closedAt ? "CLOSED"
          : g.stoppedAt ? "STOPPED"
          : g.expiresAt && g.expiresAt.getTime() < now ? "EXPIRED"
          : g.kind === "COLD" ? "COLD"
          : "OPEN";
        const daysLeft = g.expiresAt ? Math.max(0, Math.ceil((g.expiresAt.getTime() - now) / DAY_MS)) : null;
        return {
          id: g.id,
          kind: g.kind,
          createdAt: g.createdAt,
          items,
          itemTitle: null, // فرانت از items می‌سازد («۲ قلمی» یا «نام · مقدار»)
          volume: g.volume,
          frequency: g.frequency,
          delivery: g.delivery,
          deliveryCity: g.deliveryCity,
          targetPriceMinor: g.targetPriceMinor,
          note: g.note,
          expiresAt: g.expiresAt,
          stoppedAt: g.stoppedAt,
          closedAt: g.closedAt,
          resultText: g.resultText,
          status,
          daysLeft,
          recipients: g.recipients,
          offers: [...g.offers].sort(
            (a, b) => (b as { createdAt: Date }).createdAt.getTime() - (a as { createdAt: Date }).createdAt.getTime()
          ),
          offerCount: g.offerCount,
          markedCount: g.markedCount,
          minPriceMinor: g.minPriceMinor,
        };
      });

    return { groups: list, recentOfferCount };
  }

  /**
   * POST /market/setOfferStatus/:id (فاز ۴ مهاجرت · sheet-offer-status) —
   * نشانِ خصوصی خریدار روی پیشنهاد: INTERESTED | CONTACTED | REVIEWED | NONE.
   * «NONE» یا خالی = حذف نشان. فقط خریدارِ خود پیشنهاد مجاز است.
   */
  @Post("setOfferStatus/:id")
  async setOfferStatus(
    @Param("id") offerId: string,
    @Body() body: SetOfferStatusDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    if (!isObjectId(offerId)) throw AppError.notFound("Offer not found");
    const offer = await this.prisma.offer.findUnique({ where: { id: offerId }, select: { id: true, buyerId: true } });
    if (!offer) throw AppError.notFound("Offer not found");
    await assertBusinessOwner(this.prisma, user, offer.buyerId, locale);
    const status = !body.status || body.status === "NONE" ? null : body.status;
    await this.prisma.offer.update({ where: { id: offer.id }, data: { status } });
    this.invalidateBuyerSide(offer.buyerId);
    return { ok: true, status };
  }

  /**
   * GET /market/getQuoteContext (فاز ۴ مهاجرت · sc-quote) — زمینهٔ فرم «پاسخ با قیمت».
   * id = Inquiry id (پاسخ مستقیم به «به من») یا «b»+BUY listing id
   * (پاسخ به فرصت بازار / گوش‌به‌زنگ از مسیر offerBuyRequest).
   * شامل: خریدار (نام/صنف/شهر/سابقه)، کالا، حجم، جزئیات استعلام،
   * قیمت زندهٔ کاتالوگ خودم در همان کالا (پیش‌پر کردن فرم).
   */
  @Get("getQuoteContext")
  async getQuoteContext(
    @Query() query: QuoteContextQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    const isBuyListing = query.id.startsWith("b");
    const objId = query.id.slice(isBuyListing ? 1 : 0);
    if (!isObjectId(objId)) throw AppError.notFound("Not found");

    const myListingOf = async (goodId: string) =>
      this.prisma.listing.findFirst({
        where: { businessId: business.id, goodId, isActive: true, mode: { in: ["SELL", "BOTH"] } },
        orderBy: { updatedAt: "desc" },
        select: { id: true, priceMinor: true, currency: true, variantLabel: true, minOrder: true, updatedAt: true },
      });

    if (!isBuyListing) {
      const inquiry = await this.prisma.inquiry.findUnique({
        where: { id: objId },
        include: {
          buyer: { select: { id: true, slug: true, name: true, city: true, isVerified: true, trade: true, createdAt: true } },
          listing: { select: { goodId: true, good: { select: { id: true, nameFa: true, nameEn: true, unit: true } } } },
        },
      });
      if (!inquiry) throw AppError.notFound("Inquiry not found");
      await assertBusinessOwner(this.prisma, user, inquiry.sellerId, locale);

      // M4 — اقلام استعلام با آگهی/قیمتِ خودم برای هر قلم («کاتالوک تو: X»)
      const rfqItems = rfqItemsOf(inquiry);
      const myListingRows = await this.prisma.listing.findMany({
        where: {
          businessId: business.id,
          goodId: { in: rfqItems.map((it) => it.goodId) },
          isActive: true,
          mode: { in: ["SELL", "BOTH"] },
        },
        select: { id: true, goodId: true, priceMinor: true, currency: true, variantLabel: true, minOrder: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
      });
      const myByGood = new Map<string, (typeof myListingRows)[number]>();
      for (const l of myListingRows) if (!myByGood.has(l.goodId)) myByGood.set(l.goodId, l);
      const goodRows = await this.prisma.good.findMany({
        where: { id: { in: rfqItems.map((it) => it.goodId) } },
        select: { id: true, nameFa: true, nameEn: true, unit: true },
      });
      const goodById = new Map(goodRows.map((g) => [g.id, g]));
      const myListing = myByGood.get(inquiry.listing.goodId) ?? null;
      const items = rfqItems.map((it) => ({
        goodId: it.goodId,
        qty: it.qty,
        mine: !!myByGood.has(it.goodId),
        listing: myByGood.get(it.goodId)
          ? {
              id: myByGood.get(it.goodId)!.id,
              priceMinor: myByGood.get(it.goodId)!.priceMinor,
              currency: myByGood.get(it.goodId)!.currency,
              variantLabel: myByGood.get(it.goodId)!.variantLabel,
              minOrder: myByGood.get(it.goodId)!.minOrder,
              updatedAt: myByGood.get(it.goodId)!.updatedAt,
            }
          : null,
        good: goodById.get(it.goodId) ?? null,
      }));

      return {
        kind: "INQUIRY" as const,
        inquiryId: inquiry.id,
        buyListingId: null,
        buyer: { ...inquiry.buyer, memberSince: inquiry.buyer.createdAt },
        good: inquiry.listing.good,
        volume: inquiry.volume,
        frequency: inquiry.frequency,
        delivery: inquiry.delivery,
        deliveryCity: inquiry.deliveryCity,
        targetPriceMinor: inquiry.targetPriceMinor,
        note: inquiry.note,
        // M4 — مهلت سرورمبنا (پیش از M4: createdAt+۳ روز ساختگی)
        deadlineAt: inquiry.expiresAt ?? new Date(inquiry.createdAt.getTime() + 3 * 86_400_000),
        rfqClosed: !!(inquiry.closedAt || inquiry.stoppedAt),
        answered: inquiry.status === "ANSWERED",
        watching: null,
        myListing,
        items,
        itemsTotal: rfqItems.length,
      };
    }

    const need = await this.prisma.listing.findUnique({
      where: { id: objId },
      select: {
        id: true, businessId: true, mode: true, volume: true, frequency: true, isActive: true,
        business: { select: { id: true, slug: true, name: true, city: true, isVerified: true, trade: true, createdAt: true } },
        good: { select: { id: true, nameFa: true, nameEn: true, unit: true } },
      },
    });
    if (!need || need.isActive === false || need.mode === "SELL" || need.volume === null) {
      throw AppError.notFound("Buy listing not found");
    }
    const myListing = await myListingOf(need.good.id);
    // گوش‌به‌زنگ؟ (گیت معرف رفع شده؟) — بررسی نهایی در خود offerBuyRequest
    const mySellPageId = await ensurePage(this.prisma, business.id, "SELL");
    const watching = await this.prisma.follow.findUnique({
      where: {
        followerPageId_supplierPageId: {
          followerPageId: mySellPageId,
          supplierPageId: await ensurePage(this.prisma, need.businessId, "BUY"),
        },
      },
      select: { id: true },
    });
    return {
      kind: "BUY_LISTING" as const,
      inquiryId: null,
      buyListingId: need.id,
      buyer: { ...need.business, memberSince: need.business.createdAt },
      good: need.good,
      volume: need.volume,
      frequency: need.frequency,
      delivery: null,
      deliveryCity: need.business.city,
      targetPriceMinor: null,
      note: null,
      deadlineAt: null,
      watching: !!watching,
      myListing,
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
    // طرح ۸ (U60) — منبعِ رسیدن ذخیره: خود کاربر اعلام نمی‌کند، مسیرش
    // خودش می‌گوید (در اپ / از لینک / از پرومو). منبع فقط بارِ اول ثبت
    // می‌شود — باورپذیرترین لحظه، همان لحظهٔ ذخیره است.
    const source =
      body.promoId ? "PROMO" : (body.source ?? "ORGANIC");
    await this.prisma.follow.upsert({
      where: { followerPageId_supplierPageId: { followerPageId, supplierPageId } },
      create: { followerPageId, supplierPageId, source },
      update: existed ? {} : { source },
    });
    // طرح ۸ (U07) — ذخیرهٔ حاصل از پرومو: ۵٬۰۰۰ تومان از بودجهٔ کمپین
    // کم می‌شود و در گزارش کمپین می‌نشیند. best-effort — ذخیره هرگز
    // به‌خاطر کیف فروشنده نمی‌شکند.
    if (!existed && body.promoId) {
      await this.promos
        .chargeEvent(body.promoId, business.id, "FOLLOW")
        .catch(() => false);
    }
    // فالوی تازه = مشتری جدید — صاحب کاتالوگ باید همین حالا بداند
    if (!existed && supplier.ownerId) {
      await this.notifications.push({
        userId: supplier.ownerId,
        // فاز ۸ — گیتِ «اتصال‌های تازه iMach» از notifPrefs
        bizId: supplier.id,
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
        source: true,
        custType: true,
        // M6 (دفتر مشتری ۰۸) — یادداشت شخصی + مهر تاییدِ «مشتری جدید»
        note: true,
        ackAt: true,
        followerPage: {
          select: {
            business: {
              select: {
                id: true,
                slug: true,
                name: true,
                city: true,
                isVerified: true,
                // M6 — صنف مشتری برای فیلتر «صنف» دفتر مشتری (۰۸)
                trade: true,
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

    // M6 — آمار سبک هر مشتری: سفارش‌ها + استعلام‌هایش نزد من (دو groupBy — نه N+1)
    const buyerIds = rows.map((r) => r.followerPage.business.id);
    const [ordersByBuyer, inquiriesByBuyer] = buyerIds.length
      ? await Promise.all([
          this.prisma.order.groupBy({
            by: ["buyerId"],
            where: { sellerId: query.businessId, buyerId: { in: buyerIds } },
            _count: { _all: true },
          }),
          this.prisma.inquiry.groupBy({
            by: ["buyerId"],
            where: { sellerId: query.businessId, buyerId: { in: buyerIds } },
            _count: { _all: true },
          }),
        ])
      : [[], []];
    const orderCount = new Map(ordersByBuyer.map((g) => [g.buyerId, g._count._all]));
    const inquiryCount = new Map(inquiriesByBuyer.map((g) => [g.buyerId, g._count._all]));

    const mapped = rows.map((r) => ({
      id: r.followerPage.business.id,
      slug: r.followerPage.business.slug,
      name: r.followerPage.business.name,
      city: r.followerPage.business.city,
      isVerified: r.followerPage.business.isVerified,
      // M6 — صنف مشتری (فیلتر ۰۸)
      trade: r.followerPage.business.trade,
      followedAt: r.createdAt,
      viaRef: r.viaRef,
      // M6 — یادداشت شخصی + «جدید» تا تایید (FD-44/45)
      note: r.note ?? null,
      ackAt: r.ackAt ?? null,
      isNew: !r.ackAt,
      // M6 — آمار سبک هر مشتری نزد من
      orderCount: orderCount.get(r.followerPage.business.id) ?? 0,
      inquiryCount: inquiryCount.get(r.followerPage.business.id) ?? 0,
      // فاز ۵ مهاجرت — نوع مشتری از دید فروشنده: PASSING | PARTNER | CONTRACT
      custType: r.custType ?? "PASSING",
      // طرح ۸ (U60) — منبعِ رسیدن: ORGANIC | SHARED | PROMO (ردیف‌های
      // قدیمی از viaRef استنتاج می‌شوند) — برچسب ردیف + شمارندهٔ خلاصه
      source: r.source ?? (r.viaRef ? "SHARED" : "ORGANIC"),
      latestRequest: r.followerPage.business.listings[0] ?? null,
    }));
    // خط خلاصهٔ عددی شیت دنبال‌کنندگان: «۶ از لینک · ۴ از تابلو · ۲ از پرومو»
    const countBy = (src: string) =>
      mapped.filter((m) => (m as { source?: string }).source === src).length;
    const summary = {
      total: mapped.length,
      organic: countBy("ORGANIC"),
      shared: countBy("SHARED"),
      promo: countBy("PROMO"),
    };

    // active-request customers first (newest request wins), then the rest
    // in follow order — M6: مشتری تاییدنشده (جدید) از همه بالاتر (FD-44/45)
    const sorted = mapped.sort((a, b) => {
      if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
      const ra = a.latestRequest?.updatedAt?.getTime() ?? 0;
      const rb = b.latestRequest?.updatedAt?.getTime() ?? 0;
      if ((ra > 0) !== (rb > 0)) return rb > 0 ? 1 : -1;
      if (ra && rb && ra !== rb) return rb - ra;
      return b.followedAt.getTime() - a.followedAt.getTime();
    });
    return { rows: sorted, summary };
  }

  /**
   * M6 (FD-44/45) — تایید مشتری جدید: مهر ackAt روی یال فالو. idempotent —
   * تاییدِ دوباره همان مهر را نگه می‌دارد؛ ردیف از «جدید» می‌رود ولی مشتری می‌ماند.
   */
  @Post("ackFollower")
  @HttpCode(200)
  async ackFollower(
    @Body() body: AckFollowerDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    const pageId = await ensurePage(this.prisma, body.businessId, "SELL");
    const buyerPageId = await ensurePage(this.prisma, body.buyerId, "BUY");
    await this.prisma.follow.updateMany({
      where: { followerPageId: buyerPageId, supplierPageId: pageId },
      data: { ackAt: new Date() },
    });
    return { ok: true };
  }

  /**
   * M6 (دفتر مشتری ۰۸ب) — یادداشت شخصی فروشنده روی مشتری. متن ≤۵۰۰؛
   * null/خالی = پاک‌کردن یادداشت.
   */
  @Post("setFollowerNote")
  @HttpCode(200)
  async setFollowerNote(
    @Body() body: SetFollowerNoteDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    const pageId = await ensurePage(this.prisma, body.businessId, "SELL");
    const buyerPageId = await ensurePage(this.prisma, body.buyerId, "BUY");
    const note = body.note?.toString().trim() || null;
    await this.prisma.follow.updateMany({
      where: { followerPageId: buyerPageId, supplierPageId: pageId },
      data: { note },
    });
    return { ok: true, note };
  }

  /**
   * M6 (۰۸ب) — نمای جزئیات مشتری: شناسنامه (نام/صنف/شهر/نوع/از کِی/یادداشت)
   * + ۲۰ سفارش و ۲۰ استعلام آخرِ همین مشتری نزد من + مسیر «لیست خرید او».
   * یک فراخوانی = یک صفحه (جلوگیری از N+1 سمت کلاینت).
   */
  @Get("getCustomer")
  async getCustomer(
    @Query() query: CustomerQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    const pageId = await ensurePage(this.prisma, query.businessId, "SELL");
    const edge = await this.prisma.follow.findFirst({
      where: { supplierPageId: pageId, followerPage: { businessId: query.buyerId, type: "BUY" } },
      select: {
        createdAt: true,
        viaRef: true,
        source: true,
        custType: true,
        note: true,
        ackAt: true,
        followerPage: {
          select: {
            business: {
              select: {
                id: true,
                slug: true,
                name: true,
                city: true,
                trade: true,
                isVerified: true,
                owner: { select: { name: true } },
              },
            },
          },
        },
      },
    });
    if (!edge) throw AppError.notFound("Customer not found");

    const [orders, inquiries] = await Promise.all([
      this.prisma.order.findMany({
        where: { sellerId: query.businessId, buyerId: query.buyerId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          docNo: true,
          status: true,
          createdAt: true,
          history: true,
          items: true,
        },
      }),
      this.prisma.inquiry.findMany({
        where: { sellerId: query.businessId, buyerId: query.buyerId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          status: true,
          createdAt: true,
          items: true,
          listing: { select: { good: { select: { nameFa: true, nameEn: true } } } },
        },
      }),
    ]);

    // جمع اقلام فریزشدهٔ سفارش برای ردیف «جمع X تومان» (فرمت در فرانت)
    const orderRows = orders.map((o) => {
      const items = Array.isArray(o.items) ? (o.items as { lineTotalMinor?: number }[]) : [];
      const totalMinor = items.reduce(
        (s, it) => s + (typeof it.lineTotalMinor === "number" ? it.lineTotalMinor : 0),
        0
      );
      return {
        id: o.id,
        docNo: o.docNo ?? null,
        status: o.status,
        createdAt: o.createdAt,
        itemCount: items.length,
        totalMinor,
      };
    });
    const inquiryRows = inquiries.map((q) => {
      const items = Array.isArray(q.items) ? (q.items as unknown[]) : [];
      const firstName = q.listing?.good?.nameFa ?? null;
      return {
        id: q.id,
        status: q.status,
        createdAt: q.createdAt,
        itemCount: items.length,
        firstName,
      };
    });

    return {
      customer: {
        id: edge.followerPage.business.id,
        slug: edge.followerPage.business.slug,
        name: edge.followerPage.business.name,
        city: edge.followerPage.business.city,
        trade: edge.followerPage.business.trade,
        isVerified: edge.followerPage.business.isVerified,
        ownerName: edge.followerPage.business.owner?.name ?? null,
        followedAt: edge.createdAt,
        viaRef: edge.viaRef,
        source: edge.source ?? (edge.viaRef ? "SHARED" : "ORGANIC"),
        custType: edge.custType ?? "PASSING",
        note: edge.note ?? null,
        ackAt: edge.ackAt ?? null,
        isNew: !edge.ackAt,
      },
      orders: orderRows,
      inquiries: inquiryRows,
    };
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

  // ═══════════════ طرح ۸ — تحلیل ذخیره‌کنندگان / گوش‌به‌زنگ / تابلوی قیمت ═══════════════

  /**
   * GET /market/getSaverAnalysis (U60/U61) — تحلیل کالا × ذخیره‌کننده:
   * برای هر کالای فروشِ من، خریدارهایی که قیمتش را دنبال می‌کنند
   * (در لیست خریدشان همان کالا را دارند) + منبعِ رسیدنشان.
   * مشتق از دادهٔ موجود — هیچ اکشن جدیدی به خریدار تحمیل نمی‌شود.
   */
  @Get("getSaverAnalysis")
  async getSaverAnalysis(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    // کالاهای فروشِ فعال من — دو مرحله‌ای: ردیف‌های با گودِ حذف‌شده (حذف خام)
    // با رابطهٔ required، کوئری را می‌شکنند؛ گودها جدا واکشی می‌شوند.
    const myListRows = await this.prisma.listing.findMany({
      where: { businessId: business.id, isActive: true, mode: { in: ["SELL", "BOTH"] } },
      select: { id: true, goodId: true, priceMinor: true, currency: true, variantLabel: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    const goodIds = [...new Set(myListRows.map((l) => l.goodId))];
    if (goodIds.length === 0) return { items: [] };
    const goods = await this.prisma.good.findMany({
      where: { id: { in: goodIds } },
      select: { id: true, nameFa: true, nameEn: true, unit: true },
    });
    const goodById = new Map(goods.map((g) => [g.id, g]));
    const myListings = myListRows
      .map((l) => ({ ...l, good: goodById.get(l.goodId) }))
      .filter((l): l is typeof l & { good: (typeof goods)[number] } => !!l.good);

    // خریدارانی که این کالاها را دنبال می‌کنند (لیست خریدشان) — دو مرحله‌ای:
    // رابطهٔ required روی WatchedGood.business با ردیف‌های یتیم (حذف خامِ
    // کسب‌وکار در تست‌ها) کل کوئری را می‌شکند؛ پس رابطه مستقیم نمی‌خوانیم.
    const watcherRows = await this.prisma.watchedGood.findMany({
      where: { goodId: { in: goodIds }, businessId: { not: business.id } },
      select: { goodId: true, createdAt: true, businessId: true },
      take: 500,
    });
    const watcherBizIds = [...new Set(watcherRows.map((w) => w.businessId))];
    const watcherBizs = watcherBizIds.length
      ? await this.prisma.business.findMany({
          where: { id: { in: watcherBizIds } },
          select: { id: true, slug: true, name: true, city: true, isVerified: true },
        })
      : [];
    const bizById = new Map(watcherBizs.map((b) => [b.id, b]));
    const watchers = watcherRows
      .map((w) => ({ ...w, business: bizById.get(w.businessId) }))
      .filter((w): w is typeof w & { business: (typeof watcherBizs)[number] } => !!w.business);
    // خریدارانی که روی همان کالاها BUY listing دارند (اعلام نیاز واقعی) —
    // دو مرحله‌ای برای ایمنیِ ردیف‌های یتیم (همان درسِ بالا)
    const needRawRows = await this.prisma.listing.findMany({
      where: { goodId: { in: goodIds }, isActive: true, mode: { in: ["BUY", "BOTH"] }, businessId: { not: business.id } },
      select: { goodId: true, volume: true, frequency: true, updatedAt: true, businessId: true },
      take: 500,
    });
    const needBizIds = [...new Set(needRawRows.map((n) => n.businessId))];
    const needBizs = needBizIds.length
      ? await this.prisma.business.findMany({
          where: { id: { in: needBizIds } },
          select: { id: true, slug: true, name: true, city: true, isVerified: true },
        })
      : [];
    const needBizById = new Map(needBizs.map((b) => [b.id, b]));
    const needRows = needRawRows
      .map((n) => ({ ...n, business: needBizById.get(n.businessId) }))
      .filter((n): n is typeof n & { business: (typeof needBizs)[number] } => !!n.business);

    // منبعِ رسیدنِ هر خریدار به من (یال‌های ذخیرهٔ کاتالوگم)
    const mySellPageId = await ensurePage(this.prisma, business.id, "SELL");
    const edges = await this.prisma.follow.findMany({
      where: { supplierPageId: mySellPageId },
      select: { source: true, viaRef: true, custType: true, followerPage: { select: { business: { select: { id: true } } } } },
      take: 500,
    });
    const sourceOf = new Map<string, string>();
    const custTypeOf = new Map<string, string>();
    for (const e of edges) {
      const id = e.followerPage.business.id;
      if (!sourceOf.has(id)) sourceOf.set(id, e.source ?? (e.viaRef ? "SHARED" : "ORGANIC"));
      if (!custTypeOf.has(id) && e.custType) custTypeOf.set(id, e.custType);
    }

    // ساخت: کالا → ذخیره‌کنندگان (یکتا) + شمارش‌ها
    type SaverRow = {
      business: { id: string; slug: string; name: string; city: string | null; isVerified: boolean };
      source: string;
      since: Date;
      need: { volume: number | null; frequency: string | null } | null;
      /** فاز ۵ — نوع مشتری از دید فروشنده (یال فالو)؛ تعیینش با شیت دنبال‌کنندگان */
      custType?: string | null;
    };
    const byGood = new Map<string, SaverRow[]>();
    const push = (
      goodId: string,
      biz: { id: string; slug: string; name: string; city: string | null; isVerified: boolean },
      since: Date,
      need: { volume: number | null; frequency: string | null } | null
    ) => {
      const list = byGood.get(goodId) ?? [];
      if (!list.some((r) => r.business.id === biz.id)) {
        list.push({ business: biz, source: sourceOf.get(biz.id) ?? "ORGANIC", since, need, custType: custTypeOf.get(biz.id) ?? null });
        byGood.set(goodId, list);
      }
    };
    for (const w of watchers) push(w.goodId, w.business, w.createdAt, null);
    for (const n of needRows) push(n.goodId, n.business, n.updatedAt, { volume: n.volume, frequency: n.frequency });

    const items = myListings.map((l) => {
      const savers = byGood.get(l.goodId) ?? [];
      const countBy = (src: string) => savers.filter((r) => r.source === src).length;
      return {
        listingId: l.id,
        goodId: l.goodId,
        goodName: l.good.nameFa,
        unit: l.good.unit,
        priceMinor: l.priceMinor,
        currency: l.currency,
        variantLabel: l.variantLabel,
        saverCount: savers.length,
        summary: {
          total: savers.length,
          organic: countBy("ORGANIC"),
          shared: countBy("SHARED"),
          promo: countBy("PROMO"),
        },
        savers: savers.slice(0, 50),
      };
    });
    return { items };
  }

  /**
   * GET /market/getWatchedBuyerNeeds (U63) — تب «گوش به زنگ» در درخواست‌های
   * قیمت فروشنده: نیازهای خریدارهایی که صفحه SELL من آنها را دنبال می‌کند.
   * پیشنهاد روی همین نیازها از گیت ۱۰ معرف عبور می‌کند — نیازِ منتشرشده
   * خودش دعوت است.
   */
  @Get("getWatchedBuyerNeeds")
  async getWatchedBuyerNeeds(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    // M10 (N6 · Δ سند ۰۶) — منبع این خوراک از این پس NeedAlert است (زنگولهٔ
    // ردیف‌های لیست خرید عمومی ۲۳)، نه فالو؛ یال دقیق‌تر: فروشنده×خریدار×کالا
    const alerts = await this.prisma.needAlert.findMany({
      where: { sellerBusinessId: business.id },
      select: { buyerBusinessId: true, goodId: true },
      take: 500,
    });
    const watchedPairs = new Set(alerts.map((a) => `${a.buyerBusinessId}:${a.goodId}`));
    const buyerIds = [...new Set(alerts.map((a) => a.buyerBusinessId))];
    if (buyerIds.length === 0) return { needs: [], buyers: 0 };

    // نیازهای فعالِ این خریدارها (BUY listing با حجم) — فقط زوج‌های زنگوله‌خورش
    const needs = (
      await this.prisma.listing.findMany({
        where: {
          businessId: { in: buyerIds },
          goodId: { in: [...new Set(alerts.map((a) => a.goodId))] },
          isActive: true,
          mode: { in: ["BUY", "BOTH"] },
          volume: { not: null },
        },
        select: {
          id: true, volume: true, frequency: true, updatedAt: true,
          business: { select: { id: true, slug: true, name: true, city: true, isVerified: true } },
          good: { select: { id: true, nameFa: true, nameEn: true, unit: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: 100,
      })
    ).filter((n) => watchedPairs.has(`${n.business.id}:${n.good.id}`));

    // فاز ۴ مهاجرت — آیا من همین کالا را می‌فروشم؟ و آیا قبلاً به این خریدار
    // در همین کالا پیشنهاد داده‌ام؟ (بج «پاسخ دادی» در تب گوش‌به‌زنگ)
    const needGoodIds = [...new Set(needs.map((n) => n.good.id))];
    const myListings = needGoodIds.length
      ? await this.prisma.listing.findMany({
          where: { businessId: business.id, goodId: { in: needGoodIds }, isActive: true, mode: { in: ["SELL", "BOTH"] } },
          select: { id: true, goodId: true },
          orderBy: { updatedAt: "desc" },
        })
      : [];
    const myGoodListing = new Map<string, string>(); // goodId → listingId (جدیدترین)
    for (const l of myListings) if (!myGoodListing.has(l.goodId)) myGoodListing.set(l.goodId, l.id);
    const myAnsweredOffers = myListings.length
      ? await this.prisma.offer.findMany({
          where: { sellerId: business.id, listingId: { in: myListings.map((l) => l.id) } },
          select: { listingId: true, buyerId: true },
          take: 500,
        })
      : [];
    const answeredSet = new Set(myAnsweredOffers.map((o) => `${o.listingId}:${o.buyerId}`));

    return {
      buyers: buyerIds.length,
      needs: needs.map((n) => ({
        id: n.id,
        volume: n.volume,
        frequency: n.frequency,
        updatedAt: n.updatedAt,
        buyer: n.business,
        good: n.good,
        // من همین کالا را می‌فروشم؟ → «مطابق کاتالوگ تو» + شناسه برای فرم پاسخ
        // M10 — واقعی شد (قبلاً null بود): من همین کالا را می‌فروشم؟
        sellsSameGood: myGoodListing.has(n.good.id),
        myListingId: myGoodListing.get(n.good.id) ?? null,
        answeredByMe: answeredSet.has(`${myGoodListing.get(n.good.id) ?? ""}:${n.business.id}`),
      })),
    };
  }

  /**
   * GET /market/getPriceBoard (U05/U06) — تابلوهای ذخیره‌شدهٔ خریدار:
   * کالاهای لیست خرید او × آخرین قیمتِ فروشنده‌های ذخیره‌شده + تزریق
   * پرومو (فقط فروشنده‌هایی که هنوز ذخیره نکرده — ۱٬۰۰۰ تومان نمایش).
   * خوراکِ «قیمتِ زنده» — هر تغییری اینجا می‌درخشد.
   */
  @Get("getPriceBoard")
  async getPriceBoard(
    @Query() query: BusinessIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    // کالاهای لیست خرید من
    const watched = await this.prisma.watchedGood.findMany({
      where: { businessId: business.id },
      select: { goodId: true, createdAt: true },
      take: 200,
    });
    const buyRows = await this.prisma.listing.findMany({
      where: { businessId: business.id, isActive: true, mode: { in: ["BUY", "BOTH"] } },
      select: { goodId: true, volume: true, frequency: true },
      take: 200,
    });
    const goodIds = [...new Set([...watched.map((w) => w.goodId), ...buyRows.map((b) => b.goodId)])];
    if (goodIds.length === 0) return { rows: [] };

    // فروشنده‌های ذخیره‌شدهٔ من
    const myBuyPageId = await ensurePage(this.prisma, business.id, "BUY");
    const savedEdges = await this.prisma.follow.findMany({
      where: { followerPageId: myBuyPageId },
      select: { supplierPage: { select: { business: { select: { id: true, slug: true, name: true, city: true, isVerified: true } } } } },
      take: 200,
    });
    const savedSupplierIds = savedEdges.map((e) => e.supplierPage.business.id);

    // آخرین قیمتِ هر (کالا × فروشندهٔ ذخیره‌شده)
    const listings = savedSupplierIds.length
      ? await this.prisma.listing.findMany({
          where: { businessId: { in: savedSupplierIds }, goodId: { in: goodIds }, isActive: true, mode: { in: ["SELL", "BOTH"] }, priceMinor: { not: null } },
          select: {
            id: true, goodId: true, priceMinor: true, currency: true, stock: true, minOrder: true,
            variantLabel: true, updatedAt: true,
            business: { select: { id: true, slug: true, name: true, city: true, isVerified: true } },
            priceLogs: { orderBy: { createdAt: "desc" }, take: 2, select: { oldMinor: true, newMinor: true, createdAt: true } },
          },
          orderBy: { updatedAt: "desc" },
          take: 600,
        })
      : [];

    const goods = await this.prisma.good.findMany({
      where: { id: { in: goodIds } },
      select: { id: true, nameFa: true, nameEn: true, unit: true },
    });
    const goodById = new Map(goods.map((g) => [g.id, g]));

    // گروه‌بندی بر اساس کالا — یک ردیف برای هر فروشنده (آخرین)
    const rowsByGood = new Map<string, typeof listings>();
    for (const l of listings) {
      const arr = rowsByGood.get(l.goodId) ?? [];
      if (!arr.some((a) => a.business.id === l.business.id)) {
        arr.push(l);
        rowsByGood.set(l.goodId, arr);
      }
    }

    // تزریق پرومو — فقط غیرذخیره‌شده‌ها (U06)؛ best-effort
    const promoRows = await this.promos.injectPromos(business.id, goodIds).catch(() => []);

    const rows = goodIds.map((goodId) => {
      const g = goodById.get(goodId);
      const sup = (rowsByGood.get(goodId) ?? []).map((l) => {
        const lastLog = l.priceLogs[0];
        const deltaMinor = lastLog ? l.priceMinor! - lastLog.oldMinor : 0;
        return {
          listingId: l.id,
          business: l.business,
          priceMinor: l.priceMinor,
          currency: l.currency,
          stock: l.stock,
          minOrder: l.minOrder,
          variantLabel: l.variantLabel,
          updatedAt: l.updatedAt,
          deltaMinor,
        };
      });
      const prices = sup.filter((r) => r.priceMinor !== null).map((r) => r.priceMinor!);
      const promo = promoRows.find((p) => p.listing?.goodId === goodId) ?? null;
      return {
        goodId,
        goodName: g?.nameFa ?? null,
        unit: g?.unit ?? null,
        suppliers: sup.sort((a, b) => (a.priceMinor ?? Infinity) - (b.priceMinor ?? Infinity)),
        bestMinor: prices.length ? Math.min(...prices) : null,
        promo: promo
          ? {
              promoId: promo.id,
              listingId: promo.listingId,
              supplier: promo.business,
              priceMinor: promo.listing.priceMinor,
              currency: promo.listing.currency,
              variantLabel: promo.listing.variantLabel,
              goodName: promo.listing.good?.nameFa ?? null,
            }
          : null,
      };
    });
    reply.header("x-cache", "MISS");
    return { rows: rows.filter((r) => r.suppliers.length > 0 || r.promo) };
  }
}
