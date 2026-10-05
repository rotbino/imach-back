import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { normalizeFa } from "../common/catalog/catalog";
import { CacheService, TTL } from "../common/cache/cache.module";
import { CurrentLocale, CurrentUser, makeSlug, type AuthUser } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import { assertBusinessOwner, invalidateBusinessCache, uniqueSlug } from "../common/guards";
import { provinceOf } from "../common/geo/cities";
import type { Locale } from "../common/i18n/i18n";
import { t } from "../common/i18n/i18n";
import { cursorBefore, decodeCursor } from "../common/pagination/cursor";
import { PrismaService } from "../common/prisma/prisma.module";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ensurePage } from "../common/pages";
import { CreateBusinessDto, EditBusinessDto, CatalogCategoriesDto, NotifPrefsDto, SetArmsDto } from "./dto/business.dto";
import { FilesService } from "../files/files.service";
import { currencyOfCountry } from "../common/catalog/catalog";

const LISTING_SELECT = {
  id: true,
  mode: true,
  // فاز ۲ — صفحه‌ی جزئیات کالای عمومی (طرح ۰۲) به واریانت و عکس مرجع نیاز دارد
  variantLabel: true,
  // فاز ۳ — دسته‌ی شخصی کاتالوگ برای چيپ‌های ویترین عمومی
  catalogCategoryId: true,
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
  product: { select: { imageUrl: true } },
} as const;

type ListingDtoT = {
  id: string;
  mode: string;
  variantLabel?: string | null;
  catalogCategoryId?: string | null;
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
  product?: { imageUrl: string | null } | null;
};

function invalidateBusiness(cache: CacheService, businessId: string, slug?: string): void {
  cache.invalidateTag(`business:${businessId}`);
  if (slug) cache.invalidateTag(`business:slug:${slug}`);
  cache.invalidateTag(`market:board:${businessId}`);
  cache.invalidateTag(`market:ssugg:${businessId}`);
  cache.invalidateTag(`market:buyreq:${businessId}`);
  // کشِ ردیفِ assertBusinessOwner هم باید تازه شود (شهر/صنف عوض شده)
  invalidateBusinessCache(businessId);
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
        // فاز ۳ — دسته‌های شخصی کاتالوگ: چيپ‌های ویترین مالک
        customCategories: true,
        // لوکیشن دقیق فقط به صاحبش برمی‌گردد — endpoint عمومی هرگز
        lat: true,
        lng: true,
        address: true,
        // فاز ۸ (طرح ۱۴) — تنظیمات اعلان؛ null = همه روشن
        notifPrefs: true,
        // فاز ۹ (شکاف ۶) — دستیارهای فعال؛ null = هر دو روشن
        enabledArms: true,
        // فاز ۶ مهاجرت — شمارهٔ تماس/ساعت پاسخگویی/شرایط پرداخت (sc-edit-biz + sc-settings)
        phone: true,
        hours: true,
        defaultPayTerm: true,
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
        // فاز ۹ (د۹) — نقشِ ثبت‌نام، پیش‌فرضِ دستیارها (بعداً از پروفایل تغییرپذیر)
        enabledArms:
          body.intent === "sell"
            ? { sell: true, buy: false }
            : body.intent === "buy"
              ? { sell: false, buy: true }
              : null,
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
            // فاز ۳ — دسته‌های شخصی کاتالوگ برای چيپ‌های ویترین عمومی
            customCategories: true,
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
        // هر سه واکشی موازی (قبلاً دو مرحله‌ی متوالی بود)
        // طرح ۸ (U61) — شمار ذخیره‌کنندگان کاتالوگ: یال‌های فالو روی صفحهٔ SELL.
        // شمارشِ عمومیِ بی‌خطر — «ذخیره» ابزاری است (مثل بوکمارک)، نه رابطه.
        const [logo, ownerAvatar, galleries, saverCount] = await Promise.all([
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
          this.files.galleryMap(business.listings.map((l) => l.id)),
          this.prisma.follow.count({
            where: { supplierPage: { businessId: business.id, type: "SELL" } },
          }),
        ]);
        return {
          ...business,
          saverCount,
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

  /**
   * PUT /businesses/setNotifPrefs/:id — فاز ۸ (طرح ۱۴): تنظیمات اعلان
   * از پروفایل. ذخیره‌ی ادغامی (merge): فقط کلیدهای ارسال‌شده عوض می‌شوند،
   * بقیه دست‌نخورده می‌مانند — فرانت هر toggle را مستقل ذخیره می‌کند.
   * بازگرداندن prefs کامل برای به‌روزرسانیِ optimistic سمت فرانت.
   */
  @Put("setNotifPrefs/:id")
  @UseGuards(JwtAuthGuard)
  async setNotifPrefs(
    @Param("id") id: string,
    @Body() body: NotifPrefsDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, id, locale);
    const current = (business.notifPrefs as Record<string, unknown> | null) ?? {};
    const prefs = {
      ...current,
      ...(body.priceChange !== undefined ? { priceChange: body.priceChange } : {}),
      ...(body.quoteReplies !== undefined ? { quoteReplies: body.quoteReplies } : {}),
      ...(body.suggestions !== undefined ? { suggestions: body.suggestions } : {}),
      ...(body.push !== undefined ? { push: body.push } : {}),
    };
    await this.prisma.business.update({
      where: { id: business.id },
      data: { notifPrefs: prefs },
    });
    invalidateBusiness(this.cache, business.id, business.slug);
    return prefs;
  }

  /**
   * PUT /businesses/setArms/:id — فاز ۹ (شکاف ۶ — د۹): دستیارهای فعال.
   * ذخیره‌ی ادغامی (merge): فقط کلیدهای ارسال‌شده عوض می‌شوند. نتیجه هرگز
   * هر-دو-خاموش نمی‌شود — 400 با ARMS_REQUIRED («بالاخره باید از یکی
   * استفاده کنی»). سوییچر شل برای بیزینسِ تک‌بازو غیب می‌شود.
   * بازگرداندن arms کامل برای به‌روزرسانی optimistic سمت فرانت.
   */
  @Put("setArms/:id")
  @UseGuards(JwtAuthGuard)
  async setArms(
    @Param("id") id: string,
    @Body() body: SetArmsDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, id, locale);
    const current = (business.enabledArms as { sell?: boolean; buy?: boolean } | null) ?? {};
    const arms = {
      sell: body.sell !== undefined ? body.sell : (current.sell ?? true),
      buy: body.buy !== undefined ? body.buy : (current.buy ?? true),
    };
    if (!arms.sell && !arms.buy) {
      throw AppError.badRequest(
        t(locale, "business.armsRequired", "حداقل یکی از دستیارها باید فعال بماند — دستیاری که لازم ندارید را می‌توانید خاموش کنید، اما نه هر دو را"),
        "ARMS_REQUIRED"
      );
    }
    await this.prisma.business.update({
      where: { id: business.id },
      data: { enabledArms: arms },
    });
    invalidateBusiness(this.cache, business.id, business.slug);
    return arms;
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
        // فاز ۶ مهاجرت — شمارهٔ تماس / ساعت پاسخگویی / شرایط پرداخت پیش‌فرض
        ...(body.phone !== undefined
          ? { phone: body.phone ? body.phone.trim() : null }
          : {}),
        ...(body.hours !== undefined
          ? { hours: body.hours ? body.hours.trim() : null }
          : {}),
        ...(body.defaultPayTerm !== undefined
          ? { defaultPayTerm: body.defaultPayTerm ? body.defaultPayTerm.trim() : null }
          : {}),
      },
    });
    invalidateBusiness(this.cache, updated.id, business.slug); // old slug tag + new data
    return updated;
  }

  /**
   * PUT /businesses/catalogCategories/:id — فاز ۳ (طرح ۰۱): دسته‌های شخصیِ
   * کاتالوگ. فروشنده ویترینش را خودش گروه‌بندی می‌کند («هاشمی/طارم/فجر/
   * صدری» برای برنج‌فروش — «میلگرد/مقطعات/ورق» برای آهن‌فروش؛ هیچ چیز
   * هاردکد نیست). کل لیست یکجا جایگزین می‌شود تا create / تغییر نام /
   * مرتب‌سازی / حذف همگی با یک فراخوانِ idempotent انجام شوند.
   * حذف دسته فقط آگهی‌هایش را «بی‌دسته» می‌کند — خودِ آگهی سر جایش می‌ماند
   * و کالای مرجع (هسته‌ی تطابق) هرگز دست نمی‌خورد.
   */
  @Put("catalogCategories/:id")
  @UseGuards(JwtAuthGuard)
  async setCatalogCategories(
    @Param("id") id: string,
    @Body() body: CatalogCategoriesDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, id, locale);
    const categories = body.categories.map((c) => ({ id: c.id, name: c.name.trim() }));
    // یکتایی id و نام — چیپ تکراری در ویترین گیج‌کننده است
    const ids = categories.map((c) => c.id);
    const names = categories.map((c) => c.name);
    if (new Set(ids).size !== ids.length || new Set(names).size !== names.length) {
      throw AppError.badRequest(
        t(locale, "business.duplicateCategory", "نام یا شناسه‌ی دسته تکراری است"),
        "DUPLICATE_CATEGORY"
      );
    }
    const [updated] = await this.prisma.$transaction([
      this.prisma.business.update({
        where: { id: business.id },
        data: { customCategories: categories },
        select: { id: true, slug: true, customCategories: true },
      }),
      // آگهی‌هایی که دسته‌شان حذف/تغییر کرده → بی‌دسته (notIn در Prisma
      // روی nullها اعمال نمی‌شود — همان چیزی که می‌خواهیم)
      this.prisma.listing.updateMany({
        where: { businessId: business.id, catalogCategoryId: { notIn: ids } },
        data: { catalogCategoryId: null },
      }),
    ]);
    invalidateBusiness(this.cache, business.id, business.slug);
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
  async searchCatalogs(@Query() query: { q?: string; cursor?: string; limit?: string; mineId?: string }, @Res({ passthrough: true }) reply: FastifyReply) {
    const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 50);
    const q = query.q?.trim();
    // جست‌وجوی کاتالوگ‌ها — زیر کش ۶۰ثانیه‌ای؛ تغییر لیستینگ (تگ products)
    // آن را باطل می‌کند تا شمارش کاتالوگ تازه بماند
    const { value, hit } = await this.cache.wrap(
      `biz:search:${q ?? ""}|${query.cursor ?? ""}|${limit}|${query.mineId ?? ""}`,
      { ttlMs: TTL.MINUTE, tags: ["products"] },
      async () => {
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
    );
    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
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
  async getCatalogItems(@Query() query: { businessId?: string; cursor?: string; limit?: string; brandId?: string; mode?: string }, @Res({ passthrough: true }) reply: FastifyReply) {
    if (!query.businessId) throw AppError.badRequest("businessId الزامی است", "BUSINESS_ID_REQUIRED");
    const limit = Math.min(Math.max(Number(query.limit ?? 40) || 40, 1), 100);
    // ── کش ۶۰ثانیه‌ای (تگ products — ذخیره/حذف لیستینگ همان لحظه باطل می‌کند)
    const { value, hit } = await this.cache.wrap(
      `biz:catitems:${query.businessId}|${query.cursor ?? ""}|${limit}|${query.brandId ?? ""}|${query.mode ?? ""}`,
      { ttlMs: TTL.MINUTE, tags: ["products", `business:${query.businessId}`] },
      async () => this.getCatalogItemsImpl(query, limit)
    );
    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  }

  private async getCatalogItemsImpl(query: { businessId?: string; cursor?: string; limit?: string; brandId?: string; mode?: string }, limit: number) {
    // ── mode: "SELL" (کاتالوگ فروش) یا "BUY" (دستیار خرید) — پیش‌فرض SELL
    const armMode = query.mode === "BUY" ? "BUY" : "SELL";
    const modes = armMode === "BUY" ? ["BUY", "BOTH"] : ["SELL", "BOTH"];
    // ── دو کوئری مستقل، موازی (قبلاً متوالی بودند → دو رفت‌وبرگشت اضافه به Atlas)
    const [rows, allBrandRows] = await Promise.all([
      this.prisma.listing.findMany({
        where: {
          businessId: query.businessId,
          isActive: true,
          mode: { in: modes },
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
          // ── موجودی و حداقل سفارش (sell) و حجم و دوره (buy) — برای کپی عینا
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
              category: { select: { id: true, nameFa: true, nameEn: true } },
            },
          },
          // ── عکس مرجع محصول — وقتی گالری آگهی خالی است، این عکس نشان داده می‌شود
          product: { select: { imageUrl: true } },
        },
        orderBy: { id: "desc" },
        ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
        take: limit + 1,
      }),
      // ── نوار برند — از همه‌ی قلم‌های این کاتالوگ (بدون فیلتر برند)، شمارش هر برند
      this.prisma.listing.findMany({
        where: { businessId: query.businessId, isActive: true, mode: { in: modes }, brandId: { not: null } },
        select: { brandId: true, brand: { select: { id: true, name: true } } },
        take: 500,
      }),
    ]);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const galleries = await this.files.galleryMap(items.map((r) => r.id));
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
        // ── موجودی و حداقل سفارش (sell) و حجم و دوره (buy) — برای کپی عینا
        stock: r.stock,
        minOrder: r.minOrder,
        volume: r.volume,
        frequency: r.frequency,
        good: r.good,
        // ── عکس: اول گالری آگهی، اگر خالی بود عکس مرجع محصول
        thumbUrl: galleries.get(r.id)?.[0]?.thumbUrl
          ?? galleries.get(r.id)?.[0]?.url
          ?? r.product?.imageUrl
          ?? null,
      })),
      nextCursor: hasMore ? items[items.length - 1].id : null,
      brands,
    };
  }

}
