import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { CacheService } from "../common/cache/cache.module";
import { CurrentLocale, CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import type { Locale } from "../common/i18n/i18n";
import { assertBusinessOwner } from "../common/guards";
import { ensurePage } from "../common/pages";
import { refreshCatalogCount } from "../common/catalog/catalog-count";
import { PrismaService } from "../common/prisma/prisma.module";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { NotificationsService } from "../notifications/notifications.service";
import {
  CreateSupplyProposalDto,
  MyProposalsQueryDto,
  SupplyProposalItemDto,
} from "./dto/supply-proposal.dto";

/**
 * M6 — ماژول «پیشنهاد تامین» (نقشهٔ راه §۴.۳ · FD-16/19/22/23):
 *
 * · POST    — تأمین‌کننده از نمای عمومی لیست خرید قیمت می‌دهد؛ اقلامِ
 *   قیمت‌خورده همان لحظه به کاتالوک خودش می‌نشیند (تعهد عرضه)؛ صفر قلم
 *   = «فقط درخواست تامین‌کنندگی». گارد ۷روزه: یک پیشنهادِ باز به‌ازای
 *   supplier×buyer — تکرار = «نتیجه را صبر کن».
 * · GET     — پیشنهادهای بازِ دریافتیِ خریدار (بالای لیست خرید ۲۰).
 * · accept  — خریدار تایید می‌کند ⇒ دو رابطهٔ Follow (کاتالوک فروشنده را
 *   ذخیره می‌کند + فروشنده نیازهایش را دیده‌بانی می‌کند) + اعلان به فروشنده.
 * · dismiss — حذف بی‌صدا از بالای لیست.
 */
@Controller("supply-proposals")
@UseGuards(JwtAuthGuard)
export class SupplyProposalsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly notifications: NotificationsService
  ) {}

  /** پیشنهادهای بازِ دریافتی — کارت‌های بالای لیست خرید (۲۰) */
  @Get()
  async myProposals(
    @Query() query: MyProposalsQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    const rows = await this.prisma.supplyProposal.findMany({
      where: { buyerId: business.id, status: "OPEN" },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        note: true,
        items: true,
        createdAt: true,
        supplier: {
          select: { id: true, slug: true, name: true, city: true, trade: true, isVerified: true },
        },
      },
    });
    return {
      rows: rows.map((r) => {
        const items = Array.isArray(r.items) ? (r.items as Record<string, unknown>[]) : [];
        return {
          id: r.id,
          note: r.note ?? null,
          items,
          itemCount: items.length,
          createdAt: r.createdAt,
          supplier: r.supplier,
        };
      }),
    };
  }

  /**
   * ارسال پیشنهاد — از نمای عمومی لیست خرید (۳۲). اقلام تازه همان لحظه
   * به کاتالوک تامین‌کننده می‌نشیند (اگر آن کالا را نداشته باشد) با همین
   * قیمت/حداقل — حکم مالک FD-23: «به کاتالوکشم اضافه بشه، یعنی اگر وجود
   * نداره اضافه بشه».
   */
  @Post()
  @HttpCode(201)
  async create(
    @Body() body: CreateSupplyProposalDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const supplier = await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    const buyer = await this.prisma.business.findUnique({
      where: { slug: body.buyerSlug },
      select: { id: true, slug: true, name: true, ownerId: true, enabledArms: true },
    });
    if (!buyer) throw AppError.notFound("Buyer not found");
    if (buyer.id === supplier.id) {
      throw AppError.badRequest("به لیست خرید خودتان پیشنهاد نمی‌دهید", "SELF_PROPOSAL");
    }
    const buyerArms = (buyer.enabledArms ?? {}) as { buy?: boolean };
    if (buyerArms.buy === false) {
      throw AppError.badRequest("این کسب‌وکار لیست خرید فعال ندارد", "ARM_DISABLED");
    }
    const myArms = (supplier.enabledArms ?? {}) as { sell?: boolean };
    if (myArms.sell === false) {
      throw AppError.forbidden("برای پیشنهاد تامین، بازوی فروش باید فعال باشد");
    }

    // اعتبارسنجی اقلام — هر قلم باید کامل باشد (قیمت + حداقل)؛ صفر قلم = bare
    const items: SupplyProposalItemDto[] = (body.items ?? []).filter(
      (it) => it && typeof it.goodId === "string" && it.goodId
    );
    for (const it of items) {
      if (!it.priceMinor || it.priceMinor < 1 || !it.minOrder || it.minOrder < 1) {
        throw AppError.badRequest(
          "قیمت و حداقل سفارش هر قلم الزامی است — قلم ناقص نفرست",
          "PRICED_ITEM_INCOMPLETE"
        );
      }
    }

    // گارد ۷روزه (تصمیم محصول ۵/۹): یک پیشنهادِ باز به‌ازای supplier×buyer
    const openExists = await this.prisma.supplyProposal.findFirst({
      where: {
        supplierId: supplier.id,
        buyerId: buyer.id,
        status: "OPEN",
        createdAt: { gt: new Date(Date.now() - 7 * 86_400_000) },
      },
      select: { id: true, createdAt: true },
    });
    if (openExists) {
      throw AppError.conflict(
        "پیشنهاد بازِ تو هنوز پیش این خریدار است — نتیجه را صبر کن",
        "SUPPLY_PROPOSAL_EXISTS"
      );
    }

    // اقلام → تطبیق/ساخت آگهی فروش من (تعهد عرضه FD-23)
    const snapshotItems: Record<string, unknown>[] = [];
    let createdListings = 0;
    for (const it of items) {
      const good = await this.prisma.good.findUnique({
        where: { id: it.goodId },
        select: { id: true, nameFa: true, nameEn: true, unit: true },
      });
      if (!good) {
        throw AppError.badRequest("کالای یکی از اقلام پیدا نشد", "GOOD_NOT_FOUND");
      }
      // جدیدترین آگهی فعال فروشم روی همین کالا (قیمت‌دار ترجیح) — مچ
      const mine = await this.prisma.listing.findMany({
        where: {
          businessId: supplier.id,
          isActive: true,
          goodId: good.id,
          mode: { in: ["SELL", "BOTH"] },
        },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: { id: true, variantLabel: true, priceMinor: true },
      });
      let listingId: string | null = null;
      let pack: string | null = null;
      if (mine.length) {
        const priced = mine.find((l) => l.priceMinor !== null && l.priceMinor !== undefined);
        const chosen = priced ?? mine[0];
        listingId = chosen.id;
        pack = chosen.variantLabel ?? null;
      } else {
        // قلم تازه → آگهی فروش با همین قیمت/حداقل (قابل ویرایش از کاتالوک)
        const created = await this.prisma.listing.create({
          data: {
            businessId: supplier.id,
            goodId: good.id,
            mode: "SELL",
            variantKey: "",
            priceMinor: it.priceMinor,
            currency: supplier.currency,
            minOrder: it.minOrder,
            stock: null,
            city: supplier.city,
            province: supplier.province,
            country: supplier.country,
            pricedAt: new Date(),
          },
          select: { id: true },
        });
        listingId = created.id;
        createdListings++;
      }
      snapshotItems.push({
        goodId: good.id,
        name: good.nameFa,
        pack,
        listingId,
        priceMinor: it.priceMinor,
        minOrder: it.minOrder,
        unit: good.unit,
      });
    }
    if (createdListings > 0) {
      await refreshCatalogCount(this.prisma, supplier.id);
      // کش‌های کاتالوک/جستجوی من بی‌اعتبار شوند
      this.cache.invalidateTag(`business:${supplier.id}`);
      this.cache.invalidateTag(`business:slug:${supplier.slug}`);
      this.cache.invalidateTag("products");
    }

    const proposal = await this.prisma.supplyProposal.create({
      data: {
        buyerId: buyer.id,
        supplierId: supplier.id,
        items: snapshotItems as unknown as Prisma.InputJsonValue,
        note: body.note?.toString().trim() || null,
        status: "OPEN",
      },
      select: { id: true, createdAt: true },
    });

    // اعلان رخداد-محور (الگوی M5): تیترِ خودِ رخداد روی ردیف
    if (buyer.ownerId) {
      await this.notifications.push({
        userId: buyer.ownerId,
        bizId: buyer.id,
        type: "SUPPLY_PROPOSAL",
        actorId: supplier.id,
        actorName: supplier.name,
        actorSlug: supplier.slug,
        good: snapshotItems.length ? String(snapshotItems[0].name ?? "") : null,
        title: snapshotItems.length
          ? `پیشنهاد تامین جدید از ${supplier.name}`
          : `درخواست تامین‌کنندگی از ${supplier.name}`,
        url: "/buy-list",
      });
    }
    // کشِ لیست عمومی خریدار هم باید پیشنهادِ بازِ من را ببیند
    this.cache.invalidateTag(`business:slug:${buyer.slug}`);

    return {
      id: proposal.id,
      createdAt: proposal.createdAt,
      itemCount: snapshotItems.length,
      catalogAdded: createdListings,
      items: snapshotItems,
    };
  }

  /**
   * پذیرش پیشنهاد (خریدار) — هستهٔ شبکهٔ خصوصی: دو رابطهٔ Follow در یک
   * تراکنش: (۱) صفحهٔ BUY من → صفحهٔ SELL فروشنده (کاتالوکش را ذخیره
   * می‌کنم؛ در دفتر مشتریانِ او می‌نشینم) (۲) صفحهٔ SELL او → صفحهٔ BUY من
   * (نیازهایم را دیده‌بانی می‌کند — گوش‌به‌زنگ). + اعلان به فروشنده.
   */
  @Post(":id/accept")
  @HttpCode(200)
  async accept(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const proposal = await this.prisma.supplyProposal.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        buyerId: true,
        supplierId: true,
        items: true,
        buyer: { select: { id: true, slug: true, name: true, ownerId: true } },
        supplier: { select: { id: true, slug: true, name: true, ownerId: true } },
      },
    });
    if (!proposal) throw AppError.notFound("Proposal not found");
    const buyerOwned = await assertBusinessOwner(this.prisma, user, proposal.buyerId, locale);
    if (proposal.status !== "OPEN") {
      throw AppError.badRequest("این پیشنهاد قبلاً تعیین تکلیف شده است", "PROPOSAL_CLOSED");
    }

    const myPageId = await ensurePage(this.prisma, buyerOwned.id, "BUY");
    const supplierSellPageId = await ensurePage(this.prisma, proposal.supplierId, "SELL");
    const supplierBuyPageId = await ensurePage(this.prisma, proposal.supplierId, "BUY");
    const mySellPageId = await ensurePage(this.prisma, buyerOwned.id, "SELL");

    // اتمیک: وضعیت + دو یال با هم یا هیچ‌کدام (الگوی گذارهای سفارش M5)
    const [updated, followEdge] = await this.prisma.$transaction(
      async (tx) => {
        const updated = await tx.supplyProposal.update({
          where: { id: proposal.id },
          data: { status: "ACCEPTED", acceptedAt: new Date() },
        });
        // (۱) من → فروشنده: ذخیرهٔ کاتالوک + شدن مشتری
        await tx.follow.upsert({
          where: {
            followerPageId_supplierPageId: { followerPageId: myPageId, supplierPageId: supplierSellPageId },
          },
          create: { followerPageId: myPageId, supplierPageId: supplierSellPageId, source: "SHARED" },
          update: {},
        });
        // (۲) فروشنده → من: دیده‌بانی نیازها (گوش‌به‌زنگ)
        const edge = await tx.follow.upsert({
          where: {
            followerPageId_supplierPageId: { followerPageId: supplierBuyPageId, supplierPageId: mySellPageId },
          },
          create: { followerPageId: supplierBuyPageId, supplierPageId: mySellPageId, source: "SHARED" },
          update: {},
        });
        return [updated, edge] as const;
      },
      { timeout: 30_000, maxWait: 10_000 } // Iran→Atlas تأخیر — الگوی M4
    );

    // اعلان به فروشنده: تایید شد + کاتالوک ذخیره شد (رخداد-محور M5)
    if (proposal.supplier.ownerId) {
      await this.notifications.push({
        userId: proposal.supplier.ownerId,
        bizId: proposal.supplierId,
        type: "SUPPLY_PROPOSAL",
        actorId: buyerOwned.id,
        actorName: buyerOwned.name,
        actorSlug: buyerOwned.slug,
        title: `پیشنهاد تامین شما تایید شد — ${buyerOwned.name} کاتالوک شما را ذخیره کرد`,
        url: "/customers",
      });
    }

    // کش‌های دوطرفه تازه شوند
    this.cache.invalidateTag(`business:slug:${proposal.buyer.slug}`);
    this.cache.invalidateTag(`business:slug:${proposal.supplier.slug}`);
    this.cache.invalidateTag(`business:${proposal.buyerId}`);
    this.cache.invalidateTag(`business:${proposal.supplierId}`);
    this.cache.invalidateTag(`market:watch:${proposal.buyerId}`);
    this.cache.invalidateTag(`market:watch:${proposal.supplierId}`);

    return { ok: true, acceptedAt: updated.acceptedAt, followId: followEdge.id };
  }

  /** حذف پیشنهاد از بالای لیست (خریدار) — بی‌صدا و بی‌اعلان */
  @Post(":id/dismiss")
  @HttpCode(200)
  async dismiss(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const proposal = await this.prisma.supplyProposal.findUnique({
      where: { id },
      select: { id: true, status: true, buyerId: true, buyer: { select: { slug: true } } },
    });
    if (!proposal) throw AppError.notFound("Proposal not found");
    await assertBusinessOwner(this.prisma, user, proposal.buyerId, locale);
    if (proposal.status === "OPEN") {
      await this.prisma.supplyProposal.update({
        where: { id: proposal.id },
        data: { status: "DISMISSED", dismissedAt: new Date() },
      });
      this.cache.invalidateTag(`business:slug:${proposal.buyer.slug}`);
    }
    return { ok: true };
  }
}
