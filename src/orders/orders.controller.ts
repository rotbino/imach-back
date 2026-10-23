import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.module";
import { CurrentLocale, CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import type { Locale } from "../common/i18n/i18n";
import { assertBusinessOwner } from "../common/guards";
import { ensurePage } from "../common/pages";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { NotificationsService } from "../notifications/notifications.service";
import {
  AcceptOrderDto,
  BasketItemDto,
  CreateOrderDto,
  OrderIdQueryDto,
  OrdersQueryDto,
} from "./dto/order.dto";

/** ObjectId hex guard — keeps invalid params away from Prisma. */
const isObjectId = (v: string | undefined): v is string => /^[a-f\d]{24}$/i.test(v ?? "");

const DAY_MS = 86_400_000;
/** تصمیم ۱/۹ (FD-22) — مهلت تأیید تحویل خریدار: ۷ روز پس از ارسال. */
const DELIVER_GRACE_DAYS = 7;

/// شمارهٔ سند گذشته نباید غلط چاپ شود؛ این جزئیات فقط مستندسازی است.
const ORDER_STATUSES = ["NEW", "ACCEPTED", "SENT", "DELIVERED", "REJECTED", "CANCELLED"] as const;
type OrderStatus = (typeof ORDER_STATUSES)[number];

/** قلم فریزشدهٔ سفارش — منبع حقیقتِ نمایش/چاپ (۴۰/۴۱) */
interface FrozenItem {
  listingId: string | null;
  goodId: string;
  name: string;
  pack: string;
  qty: number;
  unitPriceMinor: number;
}

/** رخداد خط زمانی — یک روایت مشترک برای دو طرف (۱۰/۳۹) */
interface HistoryEntry {
  st: OrderStatus;
  at: string;
  by: "buyer" | "seller" | "system";
  note?: string;
}

function historyOf(raw: unknown): HistoryEntry[] {
  return Array.isArray(raw) ? (raw as HistoryEntry[]) : [];
}

function itemsOf(raw: unknown): FrozenItem[] {
  return Array.isArray(raw) ? (raw as FrozenItem[]) : [];
}

/** عنوان کوتاه سفارش — بج/اعلان: «برنج هاشمی + ۲ قلم» */
function orderTitle(items: FrozenItem[]): string {
  const first = items[0]?.name;
  if (!first) return "سفارش";
  return items.length > 1 ? `${first} + ${items.length - 1} قلم` : first;
}

/** «۶۰٪ نقدی + ۴۰٪ چک (تا ۶۰ روز)» — همان زبان فرم ۱۲ (سمت سرور) */
function payTxOf(pay: unknown): string {
  const p = pay as { chk?: number; days?: number } | null;
  const chk = p?.chk ?? 0;
  if (!chk) return "نقدی";
  return `${100 - chk}٪ نقدی + ${chk}٪ چک (تا ${p?.days ?? 30} روز)`;
}

/** «ارسال — حمل با فروشنده» · ship=false ⇒ «تحویل حضوری» */
function dlvTxOf(dlv: unknown): string {
  const d = dlv as { ship?: boolean; by?: string } | null;
  if (!d?.ship) return "تحویل حضوری";
  return `ارسال — حمل با ${d.by === "customer" ? "مشتری" : "فروشنده"}`;
}

const BIZ_MIN = { id: true, slug: true, name: true, city: true, isVerified: true, ownerId: true };

const ORDER_INCLUDE: Prisma.OrderInclude = {
  buyer: { select: { ...BIZ_MIN, trade: true, phone: true } },
  seller: {
    select: {
      ...BIZ_MIN,
      trade: true,
      phone: true,
      address: true,
      invoiceTaxId: true,
      invoiceNote: true,
    },
  },
};

/**
 * ماژول سفارش‌ها (M5 — سند ۰۸ §M5 · FD-18/22/26/37).
 *
 * حلقهٔ معامله تا بسته‌شدن: سبد کاتالوک (۳۱) یا پیشنهاد پذیرفته‌شده (۲۷)
 * ⇒ NEW ⇒ پذیرش (با اصلاح اقلام + شمارهٔ سند) ⇒ ارسال ⇒ تأیید تحویل ⇒
 * بایگانی/سفارش دوباره. هر گذار: آپدیت اتمیک + history + اعلانِ فقط به مقابل.
 * SENT بی‌پاسخ ⇒ ۷ روز پس از ارسال «بستن تنبل» در اولین خواندن.
 */
@Controller("orders")
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService
  ) {}

  // ═════════════════════════ ابزارهای مشترک ═════════════════════════

  /** خواندن سفارش + گارد مالکیتِ طرفِ ادعاشده (خریدار یا فروشنده) */
  private async loadOwnedOrder(
    orderId: string,
    businessId: string,
    user: AuthUser,
    locale: Locale
  ) {
    if (!isObjectId(orderId)) throw AppError.notFound("Order not found");
    const business = await assertBusinessOwner(this.prisma, user, businessId, locale);
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });
    if (!order) throw AppError.notFound("Order not found");
    if (order.buyerId !== business.id && order.sellerId !== business.id) {
      throw AppError.notFound("Order not found");
    }
    return { order, side: order.buyerId === business.id ? ("buyer" as const) : ("seller" as const) };
  }

  /** بستنِ تنبلِ ۷روزه — هر خواندنِ لیست/جزئیات اول جارو می‌کند (تصمیم ۱/۹ FD-22) */
  private async lazyCloseDue(): Promise<void> {
    const due = await this.prisma.order.findMany({
      where: { status: "SENT", deliverDeadline: { lt: new Date() } },
      select: {
        id: true,
        buyerId: true,
        sellerId: true,
        buyer: { select: BIZ_MIN },
        seller: { select: BIZ_MIN },
      },
      take: 50,
    });
    for (const o of due) {
      const row = await this.prisma.order.findUnique({
        where: { id: o.id },
        select: { history: true },
      });
      const history: HistoryEntry[] = [
        ...historyOf(row?.history),
        { st: "DELIVERED", at: new Date().toISOString(), by: "system" },
      ];
      await this.prisma.order.update({
        where: { id: o.id },
        data: { status: "DELIVERED", history: history as unknown as Prisma.InputJsonValue },
      });
      // هر دو طرف باید بدانند حلقه بسته شد — حتی بی‌کلامِ خریدار
      if (o.seller.ownerId) {
        await this.notifications.push({
          userId: o.seller.ownerId,
          bizId: o.seller.id,
          type: "ORDER",
          actorId: o.buyer.id,
          actorName: o.buyer.name,
          title: "سفارش بدون تأییدِ خریدار، خودکار بسته شد",
          good: "مهلت ۷ روزهٔ تأیید تحویل گذشت",
          url: `/sell/orders/${o.id}`,
        });
      }
      if (o.buyer.ownerId) {
        await this.notifications.push({
          userId: o.buyer.ownerId,
          bizId: o.buyer.id,
          type: "ORDER",
          actorId: o.seller.id,
          actorName: o.seller.name,
          title: "سفارش خودکار بسته شد",
          good: "۷ روز از ارسال گذشت و تأیید ندادی — سفارش بسته شد",
          url: `/buy/orders/${o.id}`,
        });
      }
    }
  }

  /** DTO کامل — نمای مشترک ۱۰/۳۹ + دادهٔ اسناد ۴۰/۴۱ */
  private toOrderDto(order: {
    id: string;
    status: string;
    originType: string;
    originId: string | null;
    items: unknown;
    totalMinor: number;
    currency: string;
    note: string | null;
    sellerNote: string | null;
    pay: unknown;
    dlv: unknown;
    docNo: number | null;
    deliverDeadline: Date | null;
    history: unknown;
    archivedAt: Date | null;
    createdAt: Date;
    buyer: { id: string; slug: string; name: string; city: string; isVerified: boolean; trade: string | null; phone: string | null };
    seller: {
      id: string;
      slug: string;
      name: string;
      city: string;
      isVerified: boolean;
      trade: string | null;
      phone: string | null;
      address: string | null;
      invoiceTaxId: string | null;
      invoiceNote: string | null;
    };
  }) {
    const daysLeft = order.deliverDeadline
      ? Math.max(0, Math.ceil((order.deliverDeadline.getTime() - Date.now()) / DAY_MS))
      : null;
    return {
      id: order.id,
      status: order.status,
      originType: order.originType,
      originId: order.originId,
      items: itemsOf(order.items),
      totalMinor: order.totalMinor,
      currency: order.currency,
      note: order.note,
      sellerNote: order.sellerNote,
      pay: (order.pay as { chk: number; days: number } | null) ?? null,
      dlv: (order.dlv as { ship: boolean; by: "seller" | "customer" } | null) ?? null,
      docNo: order.docNo,
      deliverDeadline: order.deliverDeadline?.toISOString() ?? null,
      daysLeft: order.status === "SENT" ? daysLeft : null,
      history: historyOf(order.history),
      archivedAt: order.archivedAt?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
      buyer: order.buyer,
      seller: order.seller,
    };
  }

  /** گذار وضعیت — تک‌سند اتمیک (history+status در یک آپدیت) + اعلان به مقابل */
  private async transition(
    orderId: string,
    to: OrderStatus,
    by: "buyer" | "seller",
    extraData: Record<string, unknown> = {},
    notify?: {
      userId: string | null;
      bizId: string;
      actorId: string;
      actorName: string;
      title: string;
      good: string | null;
      url: string;
    }
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { history: true },
    });
    if (!order) throw AppError.notFound("Order not found");
    const history = [...historyOf(order.history), { st: to, at: new Date().toISOString(), by }];
    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: to, history: history as unknown as Prisma.InputJsonValue, ...extraData },
    });
    if (notify?.userId) {
      await this.notifications
        .push({
          userId: notify.userId,
          bizId: notify.bizId,
          type: "ORDER",
          actorId: notify.actorId,
          actorName: notify.actorName,
          title: notify.title,
          good: notify.good,
          url: notify.url,
        })
        .catch(() => {});
    }
  }

  // ═════════════════════════ ثبت سفارش ═════════════════════════

  /** POST /orders — سبد کاتالوک (۳۱) یا پیشنهاد پذیرفته‌شده (۲۷) */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: CreateOrderDto, @CurrentUser() user: AuthUser, @CurrentLocale() locale: Locale) {
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    if (body.originType === "RFQ_OFFER") return this.createFromOffer(body, business.id);
    return this.createFromBasket(body, business.id);
  }

  /** سبد کاتالوک — اقلام از آگهی‌های زندهٔ فروشنده فریز می‌شوند */
  private async createFromBasket(body: CreateOrderDto, buyerBizId: string) {
    if (!body.supplierId || !isObjectId(body.supplierId)) {
      throw AppError.badRequest("تأمین‌کنندهٔ سفارش مشخص نیست", "SUPPLIER_REQUIRED");
    }
    if (!body.items?.length) throw AppError.badRequest("سبد خالی است", "EMPTY_BASKET");
    if (body.supplierId === buyerBizId) {
      throw AppError.badRequest("از کاتالوگ خودتان نمی‌توانید سفارش بدهید", "SELF_ORDER");
    }

    const supplier = await this.prisma.business.findUnique({
      where: { id: body.supplierId },
      select: { ...BIZ_MIN, currency: true },
    });
    if (!supplier) throw AppError.notFound("Supplier not found");

    // آگهی‌های زندهٔ همین فروشنده — قیمتِ «همین لحظه» فریز می‌شود
    const ids = body.items.map((i) => i.listingId);
    const listings = await this.prisma.listing.findMany({
      where: { id: { in: ids }, isActive: true },
      select: {
        id: true,
        businessId: true,
        mode: true,
        priceMinor: true,
        currency: true,
        minOrder: true,
        variantLabel: true,
        packaging: true,
        title: true,
        good: { select: { id: true, nameFa: true, nameEn: true } },
      },
    });
    const byId = new Map(listings.map((l) => [l.id, l]));
    const frozen: FrozenItem[] = [];
    for (const it of body.items) {
      const l = byId.get(it.listingId);
      if (!l || l.businessId !== body.supplierId) {
        throw AppError.badRequest("یکی از اقلام سبد در این کاتالوک پیدا نشد", "LISTING_NOT_FOUND");
      }
      if (l.mode === "BUY") {
        throw AppError.badRequest("این ردیف فروش نیست", "LISTING_NOT_SELL");
      }
      if (l.priceMinor == null) {
        throw AppError.badRequest("قیمت این کالا هنوز ثبت نشده — از فروشنده استعلام بگیرید", "PRICE_MISSING");
      }
      // FD-26 — گیت حداقل سفارش (سمت سرور؛ کلاینت دورزدنی نیست)
      const min = l.minOrder ?? 1;
      if (it.qty < min) {
        throw AppError.badRequest(`حداقل سفارش این کالا ${min} است`, "MIN_ORDER");
      }
      const pack =
        l.variantLabel ??
        (Array.isArray(l.packaging) && (l.packaging as { label?: string }[])[0]?.label) ??
        "";
      frozen.push({
        listingId: l.id,
        goodId: l.good.id,
        name: l.title || l.good.nameFa || l.good.nameEn || "کالا",
        pack: String(pack ?? ""),
        qty: it.qty,
        unitPriceMinor: l.priceMinor,
      });
    }

    const totalMinor = frozen.reduce((s, f) => s + f.unitPriceMinor * f.qty, 0);
    const currency =
      byId.get(body.items[0]!.listingId)?.currency ?? supplier.currency ?? "IRR";
    const history: HistoryEntry[] = [{ st: "NEW", at: new Date().toISOString(), by: "buyer" }];

    const created = await this.prisma.order.create({
      data: {
        buyerId: buyerBizId,
        sellerId: body.supplierId,
        status: "NEW",
        originType: "CATALOG_BASKET",
        items: frozen as unknown as Prisma.InputJsonValue,
        totalMinor,
        currency,
        note: body.note?.trim() || null,
        history: history as unknown as Prisma.InputJsonValue,
      },
      include: ORDER_INCLUDE,
    });

    // FD-13 — اولین سفارش = ذخیرهٔ خودکار کاتالوگ (مشتری‌شدن): یالِ فالو
    // بی‌سروصدا می‌نشیند؛ خبرِ مهم همان اعلان سفارش است (اعلان فالو نه).
    await this.silentFollow(buyerBizId, body.supplierId);

    if (supplier.ownerId) {
      await this.notifications.push({
        userId: supplier.ownerId,
        bizId: supplier.id,
        type: "ORDER",
        actorId: buyerBizId,
        actorName: (created.buyer as { name: string }).name,
        title: "سفارش جدید ثبت شد",
        good: orderTitle(frozen),
        url: `/sell/orders/${created.id}`,
      });
    }

    return this.toOrderDto(created);
  }

  /** پیشنهاد پذیرفته‌شده → سفارش (تصمیم ۲/۹ FD-22): قیمت فریز، قلم‌های
   *  بی‌قیمت نمی‌آیند؛ فقط پیشنهادِ برندهٔ گروهِ بسته سفارش می‌شود. */
  private async createFromOffer(body: CreateOrderDto, buyerBizId: string) {
    if (!body.offerId || !isObjectId(body.offerId)) {
      throw AppError.badRequest("پیشنهاد مشخص نیست", "OFFER_REQUIRED");
    }
    const existing = await this.prisma.order.findFirst({
      where: { originType: "RFQ_OFFER", originId: body.offerId },
      select: { id: true },
    });
    if (existing) {
      throw new AppError("ORDER_EXISTS", "برای این پیشنهاد قبلاً سفارش ثبت شده", HttpStatus.CONFLICT, {
        orderId: existing.id,
      });
    }

    const offer = await this.prisma.offer.findUnique({
      where: { id: body.offerId },
      include: { seller: { select: { ...BIZ_MIN, currency: true } } },
    });
    if (!offer) throw AppError.notFound("Offer not found");
    if (offer.buyerId !== buyerBizId) throw AppError.notFound("Offer not found");

    // گروه استعلام — پیوند مستقیم یا هیوریستیک legacy (همان acceptOffer)
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
    if (!groupId) {
      throw AppError.badRequest("استعلام این پیشنهاد پیدا نشد", "RFQ_NOT_FOUND");
    }

    const inq = await this.prisma.inquiry.findFirst({
      where: isObjectId(groupId) ? { OR: [{ rfqGroupId: groupId }, { id: groupId }] } : { rfqGroupId: groupId },
      include: { listing: { select: { goodId: true } } },
      orderBy: { createdAt: "asc" },
    });
    if (!inq) throw AppError.badRequest("استعلام این پیشنهاد پیدا نشد", "RFQ_NOT_FOUND");

    // گارد برنده: گروه بسته + همین پیشنهاد پذیرفته شده (یا legacy از متن نتیجه)
    const winner =
      (inq.acceptedOfferId != null && inq.acceptedOfferId === offer.id) ||
      (inq.acceptedOfferId == null &&
        !!inq.closedAt &&
        !!inq.resultText &&
        inq.resultText.includes(offer.seller.name));
    if (!winner) {
      throw AppError.badRequest("فقط پیشنهادِ پذیرفته‌شده سفارش می‌شود", "OFFER_NOT_ACCEPTED");
    }

    // اقلام: سبد استعلام × قیمت‌های پیشنهاد — قلم بی‌قیمت نمی‌آید
    const rfqItems = Array.isArray(inq.items)
      ? (inq.items as { goodId: string; qty?: number; listingId?: string | null }[]).map((x) => ({
          goodId: String(x.goodId),
          qty: Number(x.qty) || 1,
          listingId: x.listingId ? String(x.listingId) : null,
        }))
      : [{ goodId: inq.listing.goodId, qty: inq.volume ?? 1, listingId: inq.listingId }];
    const prices = (
      Array.isArray(offer.prices) && (offer.prices as unknown[]).length
        ? (offer.prices as Array<number | null>)
        : [offer.priceMinor]
    ).slice(0, rfqItems.length);

    const listingIds = rfqItems.map((i) => i.listingId).filter((x): x is string => !!x);
    const goodIds = rfqItems.map((i) => i.goodId);
    const [listingRows, goodRows] = await Promise.all([
      listingIds.length
        ? this.prisma.listing.findMany({
            where: { id: { in: listingIds } },
            select: { id: true, title: true, variantLabel: true, packaging: true },
          })
        : Promise.resolve([]),
      this.prisma.good.findMany({
        where: { id: { in: goodIds } },
        select: { id: true, nameFa: true, nameEn: true },
      }),
    ]);
    const listingMap = new Map(listingRows.map((l) => [l.id, l]));
    const goodMap = new Map(goodRows.map((g) => [g.id, g]));

    const frozen: FrozenItem[] = [];
    rfqItems.forEach((it, i) => {
      const price = prices[i] ?? null;
      if (price == null) return; // «این قلم را ندارد» — در سفارش نمی‌آید
      const l = it.listingId ? listingMap.get(it.listingId) : undefined;
      const g = goodMap.get(it.goodId);
      const pack =
        l?.variantLabel ??
        (l && Array.isArray(l.packaging) && (l.packaging as { label?: string }[])[0]?.label) ??
        "";
      frozen.push({
        listingId: it.listingId,
        goodId: it.goodId,
        name: l?.title || g?.nameFa || g?.nameEn || "کالا",
        pack: String(pack ?? ""),
        qty: it.qty,
        unitPriceMinor: price,
      });
    });
    if (!frozen.length) {
      throw AppError.badRequest("این پیشنهاد قلم قیمت‌خورده‌ای ندارد", "NO_PRICED_ITEMS");
    }

    const totalMinor = frozen.reduce((s, f) => s + f.unitPriceMinor * f.qty, 0);
    const history: HistoryEntry[] = [{ st: "NEW", at: new Date().toISOString(), by: "buyer" }];
    // یادداشت سفارش = شرایط ترجمه‌شدهٔ پیشنهاد (همان الگوی پروتوتایپ ۲۷)
    const note = `از پیشنهاد پذیرفته‌شده — شرایط: ${payTxOf(offer.pay)} · ${dlvTxOf(offer.dlv)}`;

    const created = await this.prisma.order.create({
      data: {
        buyerId: offer.buyerId,
        sellerId: offer.sellerId,
        status: "NEW",
        originType: "RFQ_OFFER",
        originId: offer.id,
        items: frozen as unknown as Prisma.InputJsonValue,
        totalMinor,
        currency: offer.currency,
        note,
        pay: (offer.pay as Prisma.InputJsonValue | null) ?? undefined,
        dlv: (offer.dlv as Prisma.InputJsonValue | null) ?? undefined,
        history: history as unknown as Prisma.InputJsonValue,
      },
      include: ORDER_INCLUDE,
    });

    if (offer.seller.ownerId) {
      await this.notifications.push({
        userId: offer.seller.ownerId,
        bizId: offer.seller.id,
        type: "ORDER",
        actorId: offer.buyerId,
        actorName: (created.buyer as { name: string }).name,
        title: "سفارش از پیشنهاد پذیرفته‌شده",
        good: orderTitle(frozen),
        url: `/sell/orders/${created.id}`,
      });
    }

    return this.toOrderDto(created);
  }

  /** FD-13 — ذخیرهٔ خودکار کاتالوک با اولین سفارش (بی‌اعلان) */
  private async silentFollow(buyerBizId: string, supplierBizId: string): Promise<void> {
    try {
      const followerPageId = await ensurePage(this.prisma, buyerBizId, "BUY");
      const supplierPageId = await ensurePage(this.prisma, supplierBizId, "SELL");
      await this.prisma.follow.upsert({
        where: { followerPageId_supplierPageId: { followerPageId, supplierPageId } },
        create: { followerPageId, supplierPageId, source: "SHARED" },
        update: {},
      });
    } catch {
      /* فالو هرگز ثبت سفارش را نمی‌شکند */
    }
  }

  // ═════════════════════════ خواندن ═════════════════════════

  /** GET /orders?businessId=&side=buy|sell — دفاتر ۰۹/۲۸ */
  @Get()
  async list(@Query() query: OrdersQueryDto, @CurrentUser() user: AuthUser, @CurrentLocale() locale: Locale) {
    await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    await this.lazyCloseDue();

    const archived = query.archived === "true";
    // ⚠ Prisma+MongoDB: فیلتر null روی فیلدِ غایب مچ نمی‌شود (missing ≠ null) —
    // پس archivedAt در JS فیلتر می‌شود، نه در where. فروشنده بایگانی ندارد.
    const rows = await this.prisma.order.findMany({
      where: query.side === "sell" ? { sellerId: query.businessId } : { buyerId: query.businessId },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const visible =
      query.side === "sell"
        ? rows
        : rows.filter((r) => (archived ? r.archivedAt != null : r.archivedAt == null));

    const orders = visible.slice(0, 100).map((r) => this.toOrderDto(r));
    return {
      orders,
      // شمارنده‌های زیرعنوان زنده (۰۹: «n سفارش جدید» · ۲۸: «n سفارش جاری»)
      ...(query.side === "sell"
        ? { newCount: orders.filter((o) => o.status === "NEW").length }
        : { currentCount: orders.filter((o) => ["NEW", "ACCEPTED", "SENT"].includes(o.status)).length }),
    };
  }

  /** GET /orders/:id — نمای ۱۰/۳۹ (یک روایت مشترک) */
  @Get(":id")
  async detail(
    @Param("id") id: string,
    @Query() query: OrderIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const { order } = await this.loadOwnedOrder(id, query.businessId, user, locale);
    await this.lazyCloseDue();
    const fresh = await this.prisma.order.findUnique({ where: { id: order.id }, include: ORDER_INCLUDE });
    if (!fresh) throw AppError.notFound("Order not found");
    return this.toOrderDto(fresh);
  }

  // ═════════════════════════ گذارها (۱۰/۳۹) ═════════════════════════

  /** پذیرش با اصلاح اقلام (۱۰) — مقدار/قیمتِ توافق نهایی فریز + شمارهٔ سند */
  @Post(":id/accept")
  async accept(
    @Param("id") id: string,
    @Body() body: AcceptOrderDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const { order, side } = await this.loadOwnedOrder(id, body.businessId, user, locale);
    if (side !== "seller") throw AppError.badRequest("فروشنده سفارش را پذیرش می‌کند", "SELLER_ONLY");
    if (order.status !== "NEW") throw AppError.badRequest("این سفارش دیگر در وضعیت ثبت‌شده نیست", "NOT_NEW");

    // اصلاح اقلام — فقط فیلدهای ارسالیِ هر قلم اعمال می‌شود (README §۵.۵)
    const items = itemsOf(order.items).map((it, i) => {
      const e = body.edits?.[i];
      if (!e) return it;
      return {
        ...it,
        ...(e.qty != null ? { qty: e.qty } : {}),
        ...(e.unitPriceMinor != null ? { unitPriceMinor: e.unitPriceMinor } : {}),
      };
    });
    const totalMinor = items.reduce((s, f) => s + f.unitPriceMinor * f.qty, 0);

    // شمارهٔ سند ترتیبی — atomic increment؛ فیش/فاکتور (۴۰/۴۱) همین را چاپ می‌کنند
    const seq = await this.prisma.business.update({
      where: { id: order.sellerId },
      data: { invoiceSeq: { increment: 1 } },
      select: { invoiceSeq: true },
    });

    const history = [
      ...historyOf(order.history),
      { st: "ACCEPTED" as OrderStatus, at: new Date().toISOString(), by: "seller" as const },
    ];
    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        status: "ACCEPTED",
        items: items as unknown as Prisma.InputJsonValue,
        totalMinor,
        sellerNote: body.note?.trim() || null,
        docNo: seq.invoiceSeq,
        history: history as unknown as Prisma.InputJsonValue,
      },
    });

    const buyer = order.buyer as { ownerId: string | null; id: string; name: string };
    if (buyer.ownerId) {
      await this.notifications.push({
        userId: buyer.ownerId,
        bizId: buyer.id,
        type: "ORDER",
        actorId: order.sellerId,
        actorName: (order.seller as { name: string }).name,
        title: "سفارش پذیرفته شد",
        good: orderTitle(items),
        url: `/buy/orders/${order.id}`,
      });
    }
    return { ok: true, status: updated.status, docNo: updated.docNo, totalMinor };
  }

  /** رد — فقط فروشنده، فقط NEW */
  @Post(":id/reject")
  async reject(
    @Param("id") id: string,
    @Body() body: OrderIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const { order, side } = await this.loadOwnedOrder(id, body.businessId, user, locale);
    if (side !== "seller") throw AppError.badRequest("فقط فروشنده می‌تواند رد کند", "SELLER_ONLY");
    if (order.status !== "NEW") throw AppError.badRequest("رد فقط در وضعیت ثبت‌شده ممکن است", "NOT_NEW");
    await this.transition(order.id, "REJECTED", "seller", {}, {
      userId: (order.buyer as { ownerId: string | null }).ownerId,
      bizId: order.buyerId,
      actorId: order.sellerId,
      actorName: (order.seller as { name: string }).name,
      title: "سفارش رد شد",
      good: orderTitle(itemsOf(order.items)),
      url: `/buy/orders/${order.id}`,
    });
    return { ok: true, status: "REJECTED" };
  }

  /** «ارسال شد» — فروشنده، ACCEPTED؛ مهلت ۷روزهٔ تأیید از همین لحظه */
  @Post(":id/send")
  async send(
    @Param("id") id: string,
    @Body() body: OrderIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const { order, side } = await this.loadOwnedOrder(id, body.businessId, user, locale);
    if (side !== "seller") throw AppError.badRequest("فروشنده ارسال را ثبت می‌کند", "SELLER_ONLY");
    if (order.status !== "ACCEPTED") throw AppError.badRequest("ارسال فقط پس از پذیرش ممکن است", "NOT_ACCEPTED");
    await this.transition(
      order.id,
      "SENT",
      "seller",
      { deliverDeadline: new Date(Date.now() + DELIVER_GRACE_DAYS * DAY_MS) },
      {
        userId: (order.buyer as { ownerId: string | null }).ownerId,
        bizId: order.buyerId,
        actorId: order.sellerId,
        actorName: (order.seller as { name: string }).name,
        title: "سفارش ارسال شد",
        good: orderTitle(itemsOf(order.items)),
        url: `/buy/orders/${order.id}`,
      }
    );
    return { ok: true, status: "SENT" };
  }

  /** «تأیید تحویل» — خریدار، SENT ⇒ بسته. (خط اتصال امتیاز sc7/sb7 → M7) */
  @Post(":id/deliver")
  async deliver(
    @Param("id") id: string,
    @Body() body: OrderIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const { order, side } = await this.loadOwnedOrder(id, body.businessId, user, locale);
    if (side !== "buyer") throw AppError.badRequest("تحویل را خریدار تأیید می‌کند", "BUYER_ONLY");
    if (order.status !== "SENT") throw AppError.badRequest("تأیید تحویل فقط پس از ارسال ممکن است", "NOT_SENT");
    // M7 — اینجا اولین سفارشِ بستهٔ موفق رویداد امتیاز sc7/sb7 می‌سازد (یکتا به‌ازای refId)
    await this.transition(order.id, "DELIVERED", "buyer", {}, {
      userId: (order.seller as { ownerId: string | null }).ownerId,
      bizId: order.sellerId,
      actorId: order.buyerId,
      actorName: (order.buyer as { name: string }).name,
      title: "سفارش تحویل شد و بسته شد",
      good: orderTitle(itemsOf(order.items)),
      url: `/sell/orders/${order.id}`,
    });
    return { ok: true, status: "DELIVERED" };
  }

  /** لغو — خریدار، فقط تا قبل از ارسال (NEW/ACCEPTED) */
  @Post(":id/cancel")
  async cancel(
    @Param("id") id: string,
    @Body() body: OrderIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const { order, side } = await this.loadOwnedOrder(id, body.businessId, user, locale);
    if (side !== "buyer") throw AppError.badRequest("سفارش را خریدار لغو می‌کند", "BUYER_ONLY");
    if (!["NEW", "ACCEPTED"].includes(order.status)) {
      throw AppError.badRequest("پس از ارسال، سفارش لغو نمی‌شود — با فروشنده هماهنگ کن", "ALREADY_SENT");
    }
    await this.transition(order.id, "CANCELLED", "buyer", {}, {
      userId: (order.seller as { ownerId: string | null }).ownerId,
      bizId: order.sellerId,
      actorId: order.buyerId,
      actorName: (order.buyer as { name: string }).name,
      title: "سفارش لغو شد",
      good: orderTitle(itemsOf(order.items)),
      url: `/sell/orders/${order.id}`,
    });
    return { ok: true, status: "CANCELLED" };
  }

  /** بایگانی خریدار (۲۸) — ردیف از فهرست می‌افتد، تاریخچه می‌ماند */
  @Post(":id/archive")
  async archive(
    @Param("id") id: string,
    @Body() body: OrderIdQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const { order, side } = await this.loadOwnedOrder(id, body.businessId, user, locale);
    if (side !== "buyer") throw AppError.badRequest("بایگانی دفتر خریدار است", "BUYER_ONLY");
    if (!["DELIVERED", "REJECTED", "CANCELLED"].includes(order.status)) {
      throw AppError.badRequest("بایگانی فقط برای سفارش‌های پایان‌یافته", "NOT_FINISHED");
    }
    await this.prisma.order.update({
      where: { id: order.id },
      data: { archivedAt: new Date() },
    });
    return { ok: true };
  }
}
