import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { normalizeFa } from "../common/catalog/catalog";
import { CacheService } from "../common/cache/cache.module";
import { CurrentLocale, CurrentUser, makeSlug, type AuthUser } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import { assertBusinessOwner, uniqueSlug } from "../common/guards";
import { provinceOf } from "../common/geo/cities";
import type { Locale } from "../common/i18n/i18n";
import { cursorBefore, decodeCursor } from "../common/pagination/cursor";
import { PrismaService } from "../common/prisma/prisma.module";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ensurePage } from "../common/pages";
import { CreateBusinessDto, EditBusinessDto, ExploreQueryDto } from "./dto/business.dto";
import { FilesService } from "../files/files.service";
import { currencyOfCountry } from "../common/catalog/catalog";

const LISTING_SELECT = {
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
} as const;

type ListingDtoT = {
  id: string;
  mode: string;
  priceMinor: number | null;
  currency: string | null;
  attrs: unknown;
  stock: number | null;
  minOrder: number | null;
  volume: number | null;
  frequency: string | null;
  brand: { id: string; name: string } | null;
  good: {
    id: string;
    nameFa: string;
    nameEn: string | null;
    unit: string;
    category: { slug: string; nameFa: string; nameEn: string };
  };
};

function invalidateBusiness(cache: CacheService, businessId: string, slug?: string): void {
  cache.invalidateTag(`business:${businessId}`);
  if (slug) cache.invalidateTag(`business:slug:${slug}`);
  cache.invalidateTag(`market:board:${businessId}`);
  cache.invalidateTag(`market:ssugg:${businessId}`);
  cache.invalidateTag(`market:buyreq:${businessId}`);
}

/** Business = the seller AND buyer identity of a user. */
@Controller("businesses")
export class BusinessesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly files: FilesService
  ) {}

  @Get("getMyBusinesses")
  @UseGuards(JwtAuthGuard)
  getMyBusinesses(@CurrentUser() user: AuthUser) {
    return this.prisma.business.findMany({
      where: { ownerId: user.id },
      select: {
        id: true,
        slug: true,
        name: true,
        activityType: true,
        trade: true,
        city: true,
        country: true,
        currency: true,
        isVerified: true,
        // لوکیشن دقیق فقط به صاحبش برمی‌گردد — endpoint عمومی هرگز
        lat: true,
        lng: true,
        address: true,
        _count: { select: { listings: true } },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  @Post("createBusiness")
  @HttpCode(201)
  @UseGuards(JwtAuthGuard)
  async createBusiness(
    @Body() body: CreateBusinessDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const slug = await uniqueSlug(this.prisma, makeSlug(body.name), locale);
    // catalog currency = the country the owner chose at signup
    const owner = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { country: true, referredById: true, refArm: true },
    });
    const country = owner?.country ?? "IR";
    const business = await this.prisma.business.create({
      data: {
        slug,
        name: body.name.trim(),
        city: body.city.trim(),
        province: provinceOf(body.city.trim()),
        country,
        currency: currencyOfCountry(country),
        phone: user.phone, // از ثبت‌نام می‌آید؛ دیگر پرسیده نمی‌شود
        trade: body.trade?.trim() || null, // صنف — درگاه کپی از هم‌صنف‌ها
        ownerId: user.id,
        // هر کسب‌وکار با دو محیط خود متولد می‌شود: کاتالوگ فروش + میز خرید
        pages: { create: [{ type: "SELL" }, { type: "BUY" }] },
      },
    });
    invalidateBusiness(this.cache, business.id, business.slug);

    // ── Referral auto-follow ───────────────────────────────────────────────
    // The user signed up through someone's catalog / invite link; now that
    // they finally own pages, the two-way relationship is born:
    //   refArm SELL (catalog invite) → the referred becomes the referrer's
    //   CUSTOMER (their BUY page follows the referrer's SELL page).
    //   refArm BUY (purchase-desk invite) → the referred becomes the
    //   referrer's SUPPLIER (the referrer's BUY page follows their SELL page).
    if (owner?.referredById) {
      try {
        const refBiz = await this.prisma.business.findFirst({
          where: { ownerId: owner.referredById },
          select: { id: true },
          orderBy: { createdAt: "asc" },
        });
        if (refBiz && refBiz.id !== business.id) {
          if (owner.refArm === "BUY") {
            const refBuyPageId = await ensurePage(this.prisma, refBiz.id, "BUY");
            const mySellPageId = await ensurePage(this.prisma, business.id, "SELL");
            await this.prisma.follow.upsert({
              where: {
                followerPageId_supplierPageId: { followerPageId: refBuyPageId, supplierPageId: mySellPageId },
              },
              create: { followerPageId: refBuyPageId, supplierPageId: mySellPageId, viaRef: true },
              update: {},
            });
          } else {
            const myBuyPageId = await ensurePage(this.prisma, business.id, "BUY");
            const refSellPageId = await ensurePage(this.prisma, refBiz.id, "SELL");
            await this.prisma.follow.upsert({
              where: {
                followerPageId_supplierPageId: { followerPageId: myBuyPageId, supplierPageId: refSellPageId },
              },
              create: { followerPageId: myBuyPageId, supplierPageId: refSellPageId, viaRef: true },
              update: {},
            });
          }
        }
      } catch {
        // attribution is best-effort — business creation must never fail for it
      }
    }

    return business;
  }

  /**
   * Public profile by slug — heavily re-read (every catalog visit) → cached.
   * Phone is deliberately NOT here: contact is the registration gate of the
   * viral loop (see getContact) — strangers must sign up to call.
   */
  @Get("getBusiness/:slug")
  async getBusiness(@Param("slug") slug: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const { value, hit } = await this.cache.wrap(
      `business:profile:${slug}`,
      { ttlMs: 60_000, tags: [`business:slug:${slug}`] },
      async () => {
        const business = await this.prisma.business.findUnique({
          where: { slug },
          select: {
            id: true,
            slug: true,
            name: true,
            activityType: true,
            city: true,
            country: true,
            currency: true,
            isVerified: true,
            isDemo: true,
            // لوکیشن دقیق و آدرس — فقط مالک در ویترین خودش می‌بیند (برای ویرایش)
            lat: true,
            lng: true,
            address: true,
            // ویترین اعتماد می‌سازد: نام شخصِ صاحب کاتالوگ + عکس پروفایلش —
            // در عمده‌فروشی طرف مقابل می‌خواهد بداند با چه کسی طرف است.
            owner: { select: { id: true, name: true, firstName: true, lastName: true } },
            listings: {
              where: { isActive: true },
              select: LISTING_SELECT,
              orderBy: { updatedAt: "desc" },
            },
          },
        });
        if (!business) return business;
        // ویترین تصویری: لوگوی کسب‌وکار + تامبنیل گالری هر آگهی — داخل همان
        // کش یک‌دقیقه‌ای؛ جابه‌جایی عکس با تگ business:{id} نامعتبر می‌شود.
        const [logo, ownerAvatar] = await Promise.all([
          this.prisma.file.findFirst({
            where: { relatedModel: "Business", relatedId: business.id, fieldKey: "logo" },
            orderBy: { createdAt: "desc" },
            select: { url: true, thumbUrl: true },
          }),
          business.owner
            ? this.prisma.file.findFirst({
                where: { relatedModel: "User", relatedId: business.owner.id, fieldKey: "avatar" },
                orderBy: { createdAt: "desc" },
                select: { url: true, thumbUrl: true },
              })
            : Promise.resolve(null),
        ]);
        const galleries = await this.files.galleryMap(business.listings.map((l) => l.id));
        return {
          ...business,
          owner: business.owner
            ? {
                ...business.owner,
                avatar: ownerAvatar ? { url: ownerAvatar.url, thumbUrl: ownerAvatar.thumbUrl } : null,
              }
            : business.owner,
          logo: logo ?? null,
          listings: business.listings.map((l) => ({ ...l, gallery: galleries.get(l.id) ?? [] })),
        };
      }
    );

    if (!value) throw AppError.notFound("Business not found");
    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  }

  /**
   * The viral gate: only an authenticated user may reveal the phone number
   * behind a catalog / buy-list. Reading the number = being a member.
   */
  @Get("getContact/:slug")
  @UseGuards(JwtAuthGuard)
  async getContact(
    @Param("slug") slug: string,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await this.prisma.business.findUnique({
      where: { slug },
      select: { id: true, name: true, phone: true },
    });
    if (!business) throw AppError.notFound("Business not found");
    return { phone: business.phone, name: business.name };
  }

  @Patch("editBusiness/:id")
  @UseGuards(JwtAuthGuard)
  async editBusiness(
    @Param("id") id: string,
    @Body() body: EditBusinessDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, id, locale);
    const updated = await this.prisma.business.update({
      where: { id: business.id },
      data: {
        ...(body.name ? { name: body.name.trim() } : {}),
        ...(body.city ? { city: body.city.trim(), province: provinceOf(body.city.trim()) } : {}),
        ...(body.activityType !== undefined ? { activityType: body.activityType } : {}),
        // صنف: null صریح = پاک کردن؛ نبودِ فیلد = بدون تغییر
        ...(body.trade !== undefined ? { trade: body.trade ? body.trade.trim() : null } : {}),
        // لوکیشن دقیق: null صریح = پاک کردن؛ نبودِ فیلد = بدون تغییر
        ...(body.lat !== undefined ? { lat: body.lat } : {}),
        ...(body.lng !== undefined ? { lng: body.lng } : {}),
        // آدرس متنی قابل ویرایش — همراه پین ذخیره می‌شود
        ...(body.address !== undefined
          ? { address: body.address ? body.address.trim() : null }
          : {}),
      },
    });
    invalidateBusiness(this.cache, updated.id, business.slug); // old slug tag + new data
    return updated;
  }

  /**
   * کپی از کاتالوگ هم‌صنف‌ها — گام ۱: پیدا کردن کاتالوگ‌ها (خواسته‌ی کاربر:
   * «به‌جای تایپ صدها کالا، اولین سوپرمارکت که کالاهاشو وارد کرد بقیه تیک بزنن»).
   * جست‌وجو روی صنف و نام؛ مرتب‌سازی بر اساس ثروتِ کاتالوگ (catalogCount) تا
   * پرترین کاتالوگِ هم‌صنف اول بیاید. سرعت: فقط ایندکس trade/contains + یک صفحه.
   */
  @Get("searchCatalogs")
  @UseGuards(JwtAuthGuard)
  async searchCatalogs(@Query() query: { q?: string; cursor?: string; limit?: string; mineId?: string }) {
    const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 50);
    const q = query.q?.trim();
    const rows = await this.prisma.business.findMany({
      where: {
        // only catalogs that actually hold something — a copy flow must never
        // open an empty shelf (قانون سرعت و قانون رضایت، هر دو)
        catalogCount: { gt: 0 },
        ...(query.mineId ? { id: { not: query.mineId } } : {}),
        ...(q ? { OR: [{ trade: { contains: q } }, { name: { contains: q } }] } : {}),
      },
      select: {
        id: true,
        slug: true,
        name: true,
        city: true,
        trade: true,
        isVerified: true,
        isDemo: true,
        catalogCount: true,
      },
      orderBy: { catalogCount: "desc" },
      ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  /**
   * کپی از کاتالوگ هم‌صنف‌ها — گام ۲: قلم‌های فروشِ یک کاتالوگ، با تامبنیل،
   * برای تیک‌زدن. هر ردیف همان کلیدهای هویتیِ مشترک را می‌آورد (productId /
   * brand / attrs / variantKey) تا کپی «همان SKU» باشد، نه دوقلوی تازه.
   *
   * نوار برند هم همین‌جا ساخته می‌شود — از خودِ قلم‌های بازگشتی، برندها با
   * شمارش استخراج می‌شوند تا کاربر روی نوار افقی کلیک کند و فقط همان برند
   * را ببیند (خواسته‌ی کاربر).
   */
  @Get("getCatalogItems")
  @UseGuards(JwtAuthGuard)
  async getCatalogItems(@Query() query: { businessId?: string; cursor?: string; limit?: string; brandId?: string }) {
    if (!query.businessId) throw AppError.badRequest("businessId الزامی است", "BUSINESS_ID_REQUIRED");
    const limit = Math.min(Math.max(Number(query.limit ?? 40) || 40, 1), 100);
    const rows = await this.prisma.listing.findMany({
      where: {
        businessId: query.businessId,
        isActive: true,
        mode: { in: ["SELL", "BOTH"] },
        ...(query.brandId ? { brandId: query.brandId } : {}),
      },
      select: {
        id: true,
        mode: true,
        priceMinor: true,
        currency: true,
        attrs: true,
        variantLabel: true,
        brandId: true,
        productId: true,
        brand: { select: { id: true, name: true } },
        good: {
          select: {
            id: true,
            nameFa: true,
            nameEn: true,
            unit: true,
            category: { select: { id: true, nameFa: true, nameEn: true } },
          },
        },
      },
      orderBy: { id: "desc" },
      ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const galleries = await this.files.galleryMap(items.map((r) => r.id));

    // ── نوار برند — از همه‌ی قلم‌های این کاتالوگ (بدون فیلتر برند)، شمارش هر برند
    const allBrandRows = await this.prisma.listing.findMany({
      where: { businessId: query.businessId, isActive: true, mode: { in: ["SELL", "BOTH"] }, brandId: { not: null } },
      select: { brandId: true, brand: { select: { id: true, name: true } } },
      take: 500,
    });
    const brandMap = new Map<string, { id: string; name: string; count: number }>();
    for (const r of allBrandRows) {
      if (!r.brand) continue;
      const cur = brandMap.get(r.brand.id);
      if (cur) cur.count += 1;
      else brandMap.set(r.brand.id, { id: r.brand.id, name: r.brand.name, count: 1 });
    }
    const brands = [...brandMap.values()].sort((a, b) => b.count - a.count).slice(0, 30);

    return {
      items: items.map((r) => ({
        id: r.id,
        mode: r.mode,
        priceMinor: r.priceMinor,
        currency: r.currency,
        variantLabel: r.variantLabel,
        attrs: r.attrs,
        brandId: r.brandId,
        brandName: r.brand?.name ?? null,
        productId: r.productId,
        good: r.good,
        thumbUrl: galleries.get(r.id)?.[0]?.thumbUrl ?? galleries.get(r.id)?.[0]?.url ?? null,
      })),
      nextCursor: hasMore ? items[items.length - 1].id : null,
      brands,
    };
  }

  /**
   * کاتالوگ تجمیعی هم‌صنف‌ها (خواسته‌ی کاربر: «به جای تک تک کاتالوگها،
   * صنف را سرچ کن، سیستم ۱۰۰ سوپرمارکتِ آن شهر را پیدا کن و کالاهایشان را
   * یونیک و قابل فیلتر با برند و دسته نشان بده»).
   *
   * تمام Listingهای فعال همه‌ی کاتالوگ‌های هم‌صنف در همان جغرافیا را می‌گیرد،
   * بر اساس Product یونیک می‌کند (چون Product خودش SKU مشترک است)، برندها و
   * دسته‌ها را با شمارش برمی‌گرداند.
   *
   * geo scope: اول شهر، اگر نتیجه کم بود استان، اگر کمتر بود کشور.
   */
  @Get("getAggregatedCatalog")
  @UseGuards(JwtAuthGuard)
  async getAggregatedCatalog(
    @Query() query: {
      trade?: string;
      city?: string;
      province?: string;
      country?: string;
      q?: string;
      brandId?: string;
      categoryId?: string;
      cursor?: string;
      limit?: string;
      mineId?: string;
    }
  ) {
    const trade = query.trade?.trim();
    if (!trade) {
      throw AppError.badRequest("صنف کسب‌وکار الزامی است", "TRADE_REQUIRED");
    }
    const limit = Math.min(Math.max(Number(query.limit ?? 40) || 40, 1), 100);
    const country = query.country?.trim() || "IR";

    // پیدا کردن کسب‌وکارهای هم‌صنف در همان جغرافیا
    // اول شهر، اگر کمتر از ۳ تا بود، استان، اگر کمتر بود کشور
    const whereTrade: Record<string, unknown> = {
      trade: { contains: trade },
      catalogCount: { gt: 0 },
      country,
      ...(query.mineId ? { id: { not: query.mineId } } : {}),
    };

    // مرحله ۱: کسب‌وکارهای هم‌صنف در همان شهر
    let businesses = await this.prisma.business.findMany({
      where: { ...whereTrade, ...(query.city ? { city: query.city } : {}) },
      select: { id: true },
      take: 200,
    });

    // اگر کمتر از ۳ کاتالوگ در شهر بود، استان را هم اضافه کن
    if (businesses.length < 3 && query.province) {
      const provinceBiz = await this.prisma.business.findMany({
        where: { ...whereTrade, province: query.province },
        select: { id: true },
        take: 200,
      });
      const seen = new Set(businesses.map((b) => b.id));
      businesses = [...businesses, ...provinceBiz.filter((b) => !seen.has(b.id))];
    }

    // اگر هنوز کم بود، کل کشور
    if (businesses.length < 3) {
      const countryBiz = await this.prisma.business.findMany({
        where: whereTrade,
        select: { id: true },
        take: 500,
      });
      const seen = new Set(businesses.map((b) => b.id));
      businesses = [...businesses, ...countryBiz.filter((b) => !seen.has(b.id))];
    }

    if (businesses.length === 0) {
      return { items: [], nextCursor: null, brands: [], categories: [], foundBusinesses: 0 };
    }

    const bizIds = businesses.map((b) => b.id);

    // مرحله ۲: لیستینگ‌های SELL/BOTH این کسب‌وکارها که productId دارند —
    // چون productId یونیک است به طور خودکار SKU یونیک می‌دهد
    const q = query.q?.trim();
    const where: Record<string, unknown> = {
      businessId: { in: bizIds },
      isActive: true,
      mode: { in: ["SELL", "BOTH"] },
      productId: { not: null },
      ...(query.brandId ? { brandId: query.brandId } : {}),
      ...(query.categoryId ? { good: { categoryId: query.categoryId } } : {}),
      ...cursorBefore(decodeCursor(query.cursor)),
    };
    if (q) {
      // جست‌وجو روی product.label یا good.nameFa
      where.OR = [
        { product: { searchText: { contains: normalizeFa(q) } } },
        { good: { searchText: { contains: normalizeFa(q) } } },
      ];
    }

    // distinct روی productId تا SKU یونیک باشد
    const rows = await this.prisma.listing.findMany({
      where,
      distinct: ["productId"],
      select: {
        id: true,
        productId: true,
        brandId: true,
        brand: { select: { id: true, name: true } },
        good: {
          select: {
            id: true,
            nameFa: true,
            nameEn: true,
            unit: true,
            category: { select: { id: true, nameFa: true, nameEn: true } },
          },
        },
        product: { select: { id: true, label: true } },
      },
      orderBy: { id: "desc" },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    // گالری — اولین عکس هر قلم
    const galleries = await this.files.galleryMap(items.map((r) => r.id));

    // نوار برند — از همه‌ی لیستینگ‌های هم‌صنف (نه فقط صفحه فعلی)
    const brandRows = await this.prisma.listing.findMany({
      where: { businessId: { in: bizIds }, isActive: true, mode: { in: ["SELL", "BOTH"] }, brandId: { not: null } },
      select: { brandId: true, brand: { select: { id: true, name: true } } },
      take: 1000,
    });
    const brandMap = new Map<string, { id: string; name: string; count: number }>();
    for (const r of brandRows) {
      if (!r.brand) continue;
      const cur = brandMap.get(r.brand.id);
      if (cur) cur.count += 1;
      else brandMap.set(r.brand.id, { id: r.brand.id, name: r.brand.name, count: 1 });
    }
    const brands = [...brandMap.values()].sort((a, b) => b.count - a.count).slice(0, 30);

    // نوار دسته — از همه‌ی لیستینگ‌های هم‌صنف
    const catRows = await this.prisma.listing.findMany({
      where: { businessId: { in: bizIds }, isActive: true, mode: { in: ["SELL", "BOTH"] } },
      select: { good: { select: { category: { select: { id: true, nameFa: true, nameEn: true } } } } },
      take: 1000,
    });
    const catMap = new Map<string, { id: string; nameFa: string; nameEn: string; count: number }>();
    for (const r of catRows) {
      const c = r.good?.category;
      if (!c) continue;
      const cur = catMap.get(c.id);
      if (cur) cur.count += 1;
      else catMap.set(c.id, { id: c.id, nameFa: c.nameFa, nameEn: c.nameEn, count: 1 });
    }
    const categories = [...catMap.values()].sort((a, b) => b.count - a.count).slice(0, 20);

    return {
      items: items.map((r) => ({
        id: r.id,
        productId: r.productId,
        brandId: r.brandId,
        brandName: r.brand?.name ?? null,
        variantLabel: r.product?.label ?? null,
        good: r.good,
        thumbUrl: galleries.get(r.id)?.[0]?.thumbUrl ?? galleries.get(r.id)?.[0]?.url ?? null,
      })),
      nextCursor: hasMore ? items[items.length - 1].id : null,
      brands,
      categories,
      foundBusinesses: businesses.length,
    };
  }

  /**
   * اکسپلور — کالاهای خرید و فروشِ همه کسب‌وکارها.
   * الگوریتم v۰ (عمدا ساده؛ بعدا با نوع کالاها و حجم کاربر کامل می‌شود):
   *   ۱) شهرِ کسب‌وکار جاری کاربر اول
   *   ۲) سمت خرید: حجمِ بزرگ‌تر اول — سمت فروش: تازه‌ترین قیمت
   * عمومی است (مثل کاتالوگ‌ها) تا مهمان‌ها هم بازار را ببینند و عضو شوند.
   */
  @Get("getExplore")
  async getExplore(@Query() query: ExploreQueryDto) {
    const sellSide = query.mode !== "BUY";
    const rows = await this.prisma.listing.findMany({
      where: sellSide
        ? { isActive: true, mode: { in: ["SELL", "BOTH"] }, priceMinor: { not: null } }
        : { isActive: true, mode: { in: ["BUY", "BOTH"] }, volume: { not: null } },
      select: {
        id: true,
        mode: true,
        priceMinor: true,
        currency: true,
        stock: true,
        minOrder: true,
        volume: true,
        frequency: true,
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
        business: {
          select: {
            id: true,
            slug: true,
            name: true,
            city: true,
            isVerified: true,
            activityType: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 300,
    });

    const city = query.city?.trim();
    rows.sort((a, b) => {
      if (city) {
        const da = a.business.city === city ? 0 : 1;
        const db = b.business.city === city ? 0 : 1;
        if (da !== db) return da - db;
      }
      const va = a.volume ?? 0;
      const vb = b.volume ?? 0;
      if (va !== vb) return vb - va;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });

    // گالری هر آگهی — اولین عکس روی کارت‌های بازار دیده می‌شود (خواسته‌ی کاربر:
    // «اولین عکس باید در هر جایی که کارت کالا داریم نمایش داده بشه»)
    const page = rows.slice(0, 100);
    const galleries = await this.files.galleryMap(page.map((r) => r.id));
    return page.map((r) => ({ ...r, gallery: galleries.get(r.id) ?? [] }));
  }
}
