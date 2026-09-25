import { Body, Controller, Delete, Get, Param, Put, Query, UseGuards } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { goodSearchText } from "../common/catalog/catalog";
import { provinceOf } from "../common/geo/cities";
import { CacheService } from "../common/cache/cache.module";
import { CurrentLocale, CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import { assertBusinessOwner } from "../common/guards";
import { t, type Locale } from "../common/i18n/i18n";
import { PrismaService } from "../common/prisma/prisma.module";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { FilesService } from "../files/files.service";
import { ProductsService, productIdentityParts } from "../products/products.service";
import { BulkSaveDto } from "../products/dto/product.dto";
import { refreshCatalogCount } from "../common/catalog/catalog-count";
import { SaveListingDto, CopyFromDto } from "./dto/listing.dto";

/**
 * Same shape as getMyListings rows — every save path returns this so the
 * client cache never meets a half-shaped listing after a save.
 */
const LISTING_SELECT = {
  id: true,
  mode: true,
  variantKey: true,
  variantLabel: true,
  productId: true,
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
} as const satisfies Prisma.ListingSelect;

/** shallow {key: value} sanity cap for category attributes */
function sanitizeAttrs(attrs: Record<string, string> | undefined): Record<string, string> | null {
  if (!attrs) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs).slice(0, 12)) {
    if (typeof v !== "string") continue;
    if (!k || k.length > 40 || v.length > 80) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

interface AttrDef {
  key: string;
  fa: string;
  en: string;
  type: "enum" | "text";
  options?: { v: string; fa: string; en: string }[];
}

/**
 * Deterministic variant key from the distinguishing attrs — the same spec
 * combination always maps to the same listing row, so saving again UPDATES
 * that variant instead of duplicating it. "" = the plain, unvarianted offer.
 */
function deriveVariantKey(attrs: Record<string, string> | null): string {
  if (!attrs) return "";
  return Object.keys(attrs)
    .sort()
    .map((k) => `${k}=${attrs[k]}`)
    .join("|")
    .slice(0, 60);
}

/** Readable fa snapshot of the attrs («۵۰۰ گرمی · کارتن») via category defs. */
function deriveVariantLabel(attrs: Record<string, string> | null, defs: AttrDef[] | null): string | null {
  if (!attrs) return null;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    const opt = defs?.find((d) => d.key === k)?.options?.find((o) => o.v === v);
    parts.push(opt ? opt.fa : v);
  }
  const label = parts.filter(Boolean).join(" · ").slice(0, 80);
  return label || null;
}

/**
 * Listing = the atomic tradable unit (business × good, unique).
 * Price lives in `priceMinor` (smallest currency unit, integer) + `currency`
 * inherited from the business. Price changes are recorded in PriceLog so the
 * live board can show trends without extra bookkeeping.
 */
@Controller("listings")
@UseGuards(JwtAuthGuard)
export class ListingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly files: FilesService,
    private readonly products: ProductsService
  ) {}

  /**
   * Cache tags of everything a listing touches. The public vitrine
   * (getBusiness/:slug) is keyed by slug, the rest by id — BOTH tags go so a
   * save/delete reaches every cached view in the same tick (خواسته‌ی کاربر:
   * عکس و کالای تازه باید همان لحظه در کاتالوگ دیده شود).
   */
  private invalidateFor(businessId: string, slug?: string): void {
    this.cache.invalidateTag(`business:${businessId}`);
    if (slug) this.cache.invalidateTag(`business:slug:${slug}`);
    this.cache.invalidateTag(`market:board:${businessId}`);
    this.cache.invalidateTag(`market:sugg:${businessId}`);
    this.cache.invalidateTag(`market:ssugg:${businessId}`);
    this.cache.invalidateTag(`market:home:${businessId}`);
    this.cache.invalidateTag(`market:buyreq:${businessId}`);
    this.cache.invalidateTag(`market:selloff:${businessId}`);
  }

  /**
   * resolve free-text brand → deduped Brand row (created on the fly); empty → detached.
   * New rows carry the creator trail: non-admin listings leave the brand
   * PROVISIONAL for the admin queue — but it stays usable right away.
   */
  private async resolveBrandId(brandName: string | undefined, user: AuthUser): Promise<string | null> {
    const name = brandName?.trim();
    if (!name) return null;
    const searchText = goodSearchText({ nameFa: name });
    const isAdmin = user.role === "ADMIN";
    const brand = await this.prisma.brand.upsert({
      where: { searchText },
      create: {
        name,
        searchText,
        source: "USER",
        status: isAdmin ? "ACTIVE" : "PROVISIONAL",
        creatorRole: isAdmin ? "ADMIN" : "USER",
        createdById: user.id,
      },
      update: {},
      select: { id: true },
    });
    return brand.id;
  }

  @Get("getMyListings")
  async getMyListings(
    @CurrentUser() user: AuthUser,
    @Query("businessId") businessId: string | undefined,
    @CurrentLocale() locale: Locale
  ) {
    if (!businessId) throw AppError.badRequest("businessId is required", "BUSINESS_ID_REQUIRED");
    await assertBusinessOwner(this.prisma, user, businessId, locale);
    const rows = await this.prisma.listing.findMany({
      where: { businessId, isActive: true },
      select: {
        id: true,
        mode: true,
        variantKey: true,
        variantLabel: true,
        productId: true,
        priceMinor: true,
        currency: true,
        attrs: true,
        stock: true,
        minOrder: true,
        volume: true,
        frequency: true,
        updatedAt: true,
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
      },
      orderBy: { updatedAt: "desc" },
    });
    // پنل مالک هم عکس می‌بیند — یک کوئری «in» برای همه‌ی ردیف‌های صفحه
    const galleries = await this.files.galleryMap(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, gallery: galleries.get(r.id) ?? [] }));
  }

  @Put("saveListing")
  async saveListing(@Body() body: SaveListingDto, @CurrentUser() user: AuthUser, @CurrentLocale() locale: Locale) {
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);

    const good = await this.prisma.good.findUnique({
      where: { id: body.goodId },
      select: { id: true, nameFa: true, category: { select: { attrs: true } } },
    });
    if (!good) throw AppError.badRequest(t(locale, "catalog.goodNotFound", "گروه محصول یافت نشد"), "GOOD_NOT_FOUND");

    // Spec consistency: SELL/BOTH require sell spec, BUY/BOTH require buy spec
    if (body.mode !== "BUY" && !body.sell) {
      throw AppError.badRequest(
        t(locale, "listing.sellSpecRequired", "برای فروش، مشخصات قیمت و موجودی الزامی است"),
        "SELL_SPEC_REQUIRED"
      );
    }
    if (body.mode !== "SELL" && !body.buy) {
      throw AppError.badRequest(
        t(locale, "listing.buySpecRequired", "برای خرید، حجم و تناوب الزامی است"),
        "BUY_SPEC_REQUIRED"
      );
    }

    const brandId = await this.resolveBrandId(body.brandName, user);
    const attrs = sanitizeAttrs(body.attrs);
    const variantKey = deriveVariantKey(attrs);
    const variantLabel = deriveVariantLabel(attrs, (good.category?.attrs as AttrDef[] | null) ?? null);

    // ── لایه‌ی مرجع محصول (لینک خاموش) — هیچ قدم و فیلد جدیدی برای کاربر ──
    // اگر کلاینت productId آورد (انتخابگر)، همان اعتبارسنجی و وصل می‌شود؛
    // وگرنه از دلِ برند+ویژگی‌هایی که همین حالا تایپ شده، find-or-create می‌شود.
    // کالای ساده بدون برند/ویژگی (فله) بدون شناسه می‌ماند — همان مسیر امروز.
    let productId: string | null = null;
    let productIdentity: { label: string; searchText: string } | null = null;
    if (body.productId) {
      const p = await this.prisma.product.findUnique({
        where: { id: body.productId },
        select: { id: true, goodId: true, status: true, label: true, searchText: true },
      });
      if (!p || p.status === "MERGED") {
        throw AppError.badRequest(t(locale, "products.notFound", "محصول مرجع یافت نشد"), "PRODUCT_NOT_FOUND");
      }
      if (p.goodId !== body.goodId) {
        throw AppError.badRequest(t(locale, "products.goodMismatch", "محصول با گروه کالا هم‌خوان نیست"), "PRODUCT_GOOD_MISMATCH");
      }
      productId = p.id;
      productIdentity = { label: p.label, searchText: p.searchText };
    } else {
      const linked = await this.products.findOrCreateForListing(user, {
        goodId: body.goodId,
        brandId,
        brandName: body.brandName,
        attrs,
        locale,
      });
      productId = linked?.id ?? null;
      productIdentity = linked ? { label: linked.label, searchText: linked.searchText } : null;
    }

    const data = {
      mode: body.mode,
      brandId, // empty input explicitly detaches the brand
      productId,
      // آگهیِ متصل به محصولِ مشترک، کلید واریانتش را از خودِ محصول می‌گیرد —
      // دو SKU از یک گود (مکنزی + باريلا) دو ردیف جدا می‌مانند و تکرارِ همان
      // انتخاب توسط همان فروشنده، همان ردیف را به‌روز می‌کند (همگرا، نه دوبله)
      ...(productIdentity ? { variantKey: productIdentity.searchText.slice(0, 60), variantLabel: productIdentity.label } : {}),
      ...(attrs ? { attrs } : {}),
      ...(productIdentity ? {} : { variantKey, variantLabel }),
      isActive: true, // saving a previously deleted variant re-lists it
      // geo snapshot — the matcher filters listings directly at scale
      city: business.city,
      province: business.province ?? provinceOf(business.city),
      country: business.country,
      ...(body.mode !== "BUY" && body.sell
        ? {
            priceMinor: body.sell.priceMinor,
            currency: business.currency, // single source of truth: the sell arm
            stock: body.sell.stock,
            minOrder: body.sell.minOrder,
          }
        : { priceMinor: null, currency: null, stock: null, minOrder: null }),
      ...(body.mode !== "SELL" && body.buy
        ? { volume: body.buy.volume, frequency: body.buy.frequency }
        : { volume: null, frequency: null }),
    };

    const identityKey = productIdentity ? productIdentity.searchText.slice(0, 60) : variantKey;
    const unique: Prisma.ListingWhereUniqueInput = {
      businessId_goodId_variantKey: { businessId: business.id, goodId: body.goodId, variantKey: identityKey },
    };
    const holder = await this.prisma.listing.findUnique({
      where: unique,
      select: { id: true, priceMinor: true },
    });

    // ── کدام ردیفِ فیزیکی نوشته می‌شود؟ (خواسته‌ی کاربر: عکس بعد از ویرایش نباید بیفتد) ──
    // • listingId (دیالوگ ویرایش): همان ردیف — id/گالری/تاریخچه دست‌نخورده
    // • ردیفِ قبل از لایه‌ی محصول (کلید فرمت قدیمی) از کلاینتِ کهنه: همان ردیف (پل legacy)
    // • هیچ‌کدام: create تازه — upsert مسابقه‌ی هم‌زمان را هم می‌بَرد
    let target: { id: string; priceMinor: number | null } | null = null;

    if (body.listingId) {
      const row = await this.prisma.listing.findUnique({
        where: { id: body.listingId },
        select: { id: true, businessId: true, goodId: true, priceMinor: true },
      });
      if (!row || row.businessId !== business.id) {
        throw AppError.notFound(t(locale, "listing.notFound", "کالا یافت نشد"));
      }
      if (row.goodId !== body.goodId) {
        throw AppError.badRequest(
          t(locale, "listing.goodMismatch", "گروه محصول این کالا قابل تغییر نیست"),
          "LISTING_GOOD_MISMATCH"
        );
      }
      target = row;
      // دوقلوی قبل از این فیکس هنوز کلید هویت را در دست دارد؟ ویرایشِ همین
      // کارت دوقلوها را یکی می‌کند — گالری و تاریخچه به ردیف هویت‌دار می‌رود
      if (holder && holder.id !== row.id) {
        await this.convergeFork(row.id, holder.id);
        target = holder;
      }
    } else if (!holder) {
      // پل legacy — کلاینتِ کهنه (JS کش‌شده) listingId نمی‌فرستد؛ ردیفِ قدیمیِ
      // همین پیشنهاد با کلید فرمت قدیمی پیدا و همان به‌روز می‌شود، نه دوقلوی بی‌عکس
      const legacyKey = deriveVariantKey(attrs); // بدون attrs همان "" قدیمی
      const legacy = await this.prisma.listing.findFirst({
        where: {
          businessId: business.id,
          goodId: body.goodId,
          isActive: true,
          productId: null,
          variantKey: legacyKey,
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true, priceMinor: true },
      });
      if (legacy) target = legacy;
    }

    let listing;
    if (target) {
      try {
        listing = await this.prisma.listing.update({ where: { id: target.id }, data, select: LISTING_SELECT });
      } catch (e) {
        // کلید هویت بین چک و آپدیت اشغال شد (ریس نادر) — دوقلوها یکی می‌شوند
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
        const forkHolder = await this.prisma.listing.findUnique({ where: unique, select: { id: true, priceMinor: true } });
        if (!forkHolder) throw e;
        await this.convergeFork(target.id, forkHolder.id);
        target = forkHolder;
        listing = await this.prisma.listing.update({ where: { id: forkHolder.id }, data, select: LISTING_SELECT });
      }
    } else {
      listing = await this.prisma.listing.upsert({
        where: unique,
        create: { businessId: business.id, goodId: body.goodId, ...data },
        update: data,
        select: LISTING_SELECT,
      });
    }

    const prevMinor = target ? target.priceMinor : (holder?.priceMinor ?? null);
    if (prevMinor !== null && listing.priceMinor !== null && prevMinor !== listing.priceMinor) {
      await this.prisma.priceLog.create({
        data: { listingId: listing.id, oldMinor: prevMinor, newMinor: listing.priceMinor },
      });
    }

    this.invalidateFor(business.id, business.slug);
    return listing;
  }

  /**
   * دوقلویِ قبل از فیکسِ کلید هویت: فایل‌ها (گالری)، تاریخچه قیمت، استعلام و
   * پیشنهادهای ردیف کهنه به ردیف بازمانده منتقل و ردیف کهنه بازنشسته می‌شود.
   * variantKey بخشی از ایندکس یکتاست — ردیفِ بازنشسته کلیدش را آزاد می‌کند.
   */
  private async convergeFork(fromId: string, intoId: string): Promise<void> {
    await this.prisma.file.updateMany({
      where: { relatedModel: "Listing", relatedId: fromId },
      data: { relatedId: intoId },
    });
    await this.prisma.priceLog.updateMany({ where: { listingId: fromId }, data: { listingId: intoId } });
    await this.prisma.inquiry.updateMany({ where: { listingId: fromId }, data: { listingId: intoId } });
    await this.prisma.offer.updateMany({ where: { listingId: fromId }, data: { listingId: intoId } });
    await this.prisma.listing.update({
      where: { id: fromId },
      data: { isActive: false, variantKey: `fork:${fromId}` },
    });
  }

  /**
   * PUT /listings/bulkSave — one picker confirmation → N listings
   * (خواسته‌ی کاربر: فروشنده‌ی پرقلم تیک می‌زند، قیمت‌ها را در یک جدول فشرده
   * پر می‌کند، یک‌جا ثبت می‌کند). Same upsert contract as saveListing with
   * variantKey="" — the plain offer of each picked Product.
   * BUY rows MAY omit volume — the buy list forms gradually («تیک بزن،
   * مقدارش را بعداً بده») and shows them with a «مقدار بعداً» badge.
   * SELL rows MAY omit price too — the scanner loop lands SKU first,
   * price later; they wait in the «نیاز به تکمیل قیمت» tray.
   */
  @Put("bulkSave")
  async bulkSave(@Body() body: BulkSaveDto, @CurrentUser() user: AuthUser, @CurrentLocale() locale: Locale) {
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    if (body.items.length === 0) return { saved: 0, failed: 0, items: [] };

    // one shot — products of THIS batch only, MERGED ones fail per-item
    const ids = [...new Set(body.items.map((i) => i.productId))];
    const productRows = await this.prisma.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, goodId: true, status: true, brandId: true, label: true, searchText: true },
    });
    const productMap = new Map(productRows.map((p) => [p.id, p]));

    let saved = 0;
    let failed = 0;
    const savedRows: { productId: string; listingId: string }[] = [];

    // پل legacy — ردیف‌های قبل از لایه‌ی محصول (productId null، کلید قدیمی) که
    // همین پیشنهاد را از قبل دارند: همان ردیف به‌روز می‌شود تا گالری و
    // تاریخچه‌اش بماند، نه یک دوقلوی بی‌عکس (خواسته‌ی کاربر)
    const batchGoodIds = [...new Set(productRows.map((p) => p.goodId))];
    const legacyRows = await this.prisma.listing.findMany({
      where: { businessId: business.id, goodId: { in: batchGoodIds }, isActive: true, productId: null },
      select: { id: true, goodId: true, attrs: true, brand: { select: { name: true } } },
    });
    const legacyByIdentity = new Map<string, string>();
    for (const l of legacyRows) {
      const identity = productIdentityParts(l.brand?.name ?? undefined, (l.attrs as Record<string, string> | null) ?? null);
      if (identity) legacyByIdentity.set(`${l.goodId}|${identity.searchText.slice(0, 60)}`, l.id);
    }

    for (const item of body.items) {
      const p = productMap.get(item.productId);
      if (!p || p.status === "MERGED") {
        failed++;
        continue;
      }
      const data = {
        mode: body.mode,
        brandId: p.brandId ?? null,
        productId: p.id,
        attrs: null,
        // variantKey از هویت محصول — هر SKU پیک‌شده ردیف خودش را می‌گیرد
        variantKey: p.searchText.slice(0, 60),
        variantLabel: p.label,
        isActive: true,
        city: business.city,
        province: business.province ?? provinceOf(business.city),
        country: business.country,
        ...(body.mode === "BUY"
          ? {
              priceMinor: null,
              currency: null,
              stock: null,
              minOrder: null,
              volume: item.volume ?? null,
              frequency: item.frequency ?? "MONTHLY",
            }
          : {
              // SELL و BOTH: قیمت اختیاری است (صف اسکنر — «اول اسکن، آخر قیمت»)؛
              // BOTH حجم خرید را هم روی همان ردیف نگه می‌دارد
              priceMinor: item.priceMinor ?? null,
              currency: item.priceMinor ? business.currency : null,
              stock: item.stock ?? 0,
              minOrder: item.minOrder ?? (item.priceMinor ? 1 : null),
              volume: body.mode === "BOTH" ? item.volume ?? null : null,
              frequency: body.mode === "BOTH" ? item.frequency ?? "MONTHLY" : null,
            }),
      };
      const unique = { businessId_goodId_variantKey: { businessId: business.id, goodId: p.goodId, variantKey: p.searchText.slice(0, 60) } };
      const legacyId = legacyByIdentity.get(`${p.goodId}|${p.searchText.slice(0, 60)}`) ?? null;
      let row;
      if (legacyId) {
        try {
          row = await this.prisma.listing.update({ where: { id: legacyId }, data, select: { id: true } });
        } catch (e) {
          // هم‌زمان یک ردیف هویت‌دار ساخته شده؟ دوقلو یکی می‌شود، بعد ردیفِ هویت‌دار
          if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
          const forkHolder = await this.prisma.listing.findUnique({ where: unique, select: { id: true } });
          if (!forkHolder) throw e;
          await this.convergeFork(legacyId, forkHolder.id);
          row = await this.prisma.listing.update({ where: { id: forkHolder.id }, data, select: { id: true } });
        }
      } else {
        row = await this.prisma.listing.upsert({
          where: unique,
          create: { businessId: business.id, goodId: p.goodId, ...data },
          update: data,
          select: { id: true },
        });
      }
      saved++;
      savedRows.push({ productId: p.id, listingId: row.id });
    }

    if (saved > 0) {
      this.invalidateFor(business.id, business.slug);
      void refreshCatalogCount(this.prisma, business.id);
    }
    return { saved, failed, items: savedRows };
  }

  @Delete("deleteListing/:id")
  async deleteListing(@Param("id") id: string, @CurrentUser() user: AuthUser, @CurrentLocale() locale: Locale) {
    if (!/^[0-9a-fA-F]{24}$/.test(id)) throw AppError.notFound("Listing not found"); // bad id → 404, not a 500
    const listing = await this.prisma.listing.findUnique({
      where: { id },
      select: { id: true, businessId: true, isActive: true },
    });
    if (!listing) throw AppError.notFound("Listing not found");
    const owner = await assertBusinessOwner(this.prisma, user, listing.businessId, locale);
    // SOFT delete — the row leaves the catalog but Inquiry/Offer/PriceLog
    // history (the price-trend chart) stays intact. Re-saving the same spec
    // re-lists it.
    await this.prisma.listing.update({ where: { id: listing.id }, data: { isActive: false } });
    this.invalidateFor(listing.businessId, owner.slug);
    void refreshCatalogCount(this.prisma, listing.businessId);
    return { ok: true };
  }

  /**
   * PUT /listings/copyFrom — «اضافه کردن به کاتالوگ من» در جریان کپی از
   * هم‌صنف‌ها. هر قلمِ تیک‌شده به کاتالوگ من می‌آید به‌عنوان ردیف فروشِ
   * بی‌قیمت (قیمت‌گذاری بعداً) با همان کلیدهای هویتی مشترک؛ عکس‌ها به‌صورت
   * اشتراکی کپی می‌شوند (ردیف تازه، همان بایت‌ها — metadata.copiedFrom
   * نگهبان حذف دوتایی). قلمی که خودم از قبل دارم (همان goodId+variantKey)
   * بی‌سروصدا رد می‌شود — کپی هرگز روی ردیف خودم رونویسی نمی‌کند.
   */
  @Put("copyFrom")
  async copyFrom(@Body() body: CopyFromDto, @CurrentUser() user: AuthUser, @CurrentLocale() locale: Locale) {
    const business = await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    const ids = [...new Set(body.sourceListingIds)].filter((id) => /^[0-9a-fA-F]{24}$/.test(id));
    if (ids.length === 0) return { copied: 0, already: 0, failed: 0 };

    const sources = await this.prisma.listing.findMany({
      where: { id: { in: ids }, businessId: body.sourceBusinessId, isActive: true },
      select: {
        id: true,
        goodId: true,
        productId: true,
        brandId: true,
        attrs: true,
        variantKey: true,
        variantLabel: true,
        mode: true,
      },
    });
    if (sources.length === 0) throw AppError.notFound("Source listings not found");

    // پیوند هویتی برای منابعِ قبل از لایه‌ی محصول — اگر برای (گود، برند+attrs)
    // منبع، Product مشترکی هست، کپی به همان SKU وصل می‌شود (نه دوقلوی بی‌هویت)
    const brandsOfSources = await this.prisma.brand.findMany({
      where: { id: { in: [...new Set(sources.map((s) => s.brandId).filter((v): v is string => !!v))] } },
      select: { id: true, name: true },
    });
    const brandNameById = new Map(brandsOfSources.map((b) => [b.id, b.name]));
    const attachKey = new Map<string, string>();
    const missingProductIds = [...new Set(sources.filter((s) => !s.productId).map((s) => s.goodId))];
    const candidates = missingProductIds.length
      ? await this.prisma.product.findMany({
          where: { goodId: { in: missingProductIds }, status: { not: "MERGED" } },
          select: { id: true, goodId: true, searchText: true },
        })
      : [];
    for (const s of sources) {
      if (s.productId) continue;
      const identity = productIdentityParts(brandNameById.get(s.brandId ?? "") ?? undefined, (s.attrs as Record<string, string> | null) ?? null);
      if (!identity) continue;
      const hit = candidates.find((c) => c.goodId === s.goodId && c.searchText === identity.searchText);
      if (hit) attachKey.set(s.id, hit.id);
    }

    // کلیدهای هویتی موجود روی سمت من — کپی هرگز ردیف فعال من را رونویسی
    // نمی‌کند؛ ردیفِ بازنشسته (حذف‌شده) با کپی تازه دوباره زنده می‌شود، چون
    // کلید یکتا [businessId, goodId, variantKey] به isActive کاری ندارد
    const mine = await this.prisma.listing.findMany({
      where: { businessId: business.id, goodId: { in: [...new Set(sources.map((s) => s.goodId))] } },
      select: { id: true, goodId: true, variantKey: true, isActive: true, priceMinor: true, volume: true, mode: true },
    });
    const mineByKey = new Map(mine.map((m) => [`${m.goodId}|${m.variantKey}`, m]));

    let copied = 0;
    let already = 0;
    let failed = 0;
    for (const s of sources) {
      const key = `${s.goodId}|${s.variantKey}`;
      const existing = mineByKey.get(key);
      if (existing?.isActive) {
        already++;
        continue;
      }
      try {
        const data = {
          mode: "SELL", // قیمت‌گذاری با خودم — فعلاً بی‌قیمت در سینی «نیاز به تکمیل»
          productId: s.productId ?? attachKey.get(s.id) ?? null,
          brandId: s.brandId,
          attrs: (s.attrs as Record<string, string> | null) ?? null,
          variantLabel: s.variantLabel,
          isActive: true,
          priceMinor: null,
          currency: null,
          stock: null,
          minOrder: null,
          volume: null,
          frequency: null,
          city: business.city,
          province: business.province ?? provinceOf(business.city),
          country: business.country,
        };
        if (existing) {
          // باززنده‌سازی — قیمت/حجم کهنه هم پاک می‌شوند تا کپی، تازه باشد
          await this.prisma.listing.update({ where: { id: existing.id }, data });
        } else {
          await this.prisma.listing.create({
            data: { businessId: business.id, goodId: s.goodId, variantKey: s.variantKey, ...data },
            select: { id: true },
          });
        }
        copied++;
      } catch {
        failed++;
      }
    }

    // عکس‌ها — ردیف تازه با همان بایت‌ها؛ فقط برای قلم‌هایی که واقعاً ساخته شدند
    if (copied > 0) {
      // re-read MY fresh rows by identity — the copy loop may have collapsed
      const freshRows = await this.prisma.listing.findMany({
        where: {
          businessId: business.id,
          goodId: { in: [...new Set(sources.map((s) => s.goodId))] },
          isActive: true,
        },
        select: { id: true, goodId: true, variantKey: true },
      });
      const freshByKey = new Map(freshRows.map((r) => [`${r.goodId}|${r.variantKey}`, r.id]));
      const sourceFiles = await this.prisma.file.findMany({
        where: { relatedModel: "Listing", relatedId: { in: sources.map((s) => s.id) }, fieldKey: "gallery" },
        orderBy: { createdAt: "asc" },
        take: 600,
      });
      const myFileKeys = new Set(
        (
          await this.prisma.file.findMany({
            where: { relatedModel: "Listing", relatedId: { in: [...freshByKey.values()] }, fieldKey: "gallery" },
            select: { relatedId: true, storageKey: true },
          })
        ).map((f) => `${f.relatedId}|${f.storageKey}`)
      );
      const sourceById = new Map(sources.map((s) => [s.id, s]));
      for (const f of sourceFiles) {
        const src = sourceById.get(f.relatedId!);
        if (!src) continue;
        const newId = freshByKey.get(`${src.goodId}|${src.variantKey}`);
        if (!newId) continue;
        if (myFileKeys.has(`${newId}|${f.storageKey}`)) continue; // already attached once
        await this.prisma.file.create({
          data: {
            ownerId: user.id,
            relatedModel: "Listing",
            relatedId: newId,
            fieldKey: "gallery",
            description: f.description,
            name: f.name,
            mimeType: f.mimeType,
            size: f.size,
            url: f.url,
            thumbUrl: f.thumbUrl,
            storageKey: f.storageKey,
            thumbStorageKey: f.thumbStorageKey,
            metadata: { ...(f.metadata as object | null), copiedFrom: f.id },
          },
        });
        myFileKeys.add(`${newId}|${f.storageKey}`);
      }
      this.invalidateFor(business.id, business.slug);
      void refreshCatalogCount(this.prisma, business.id);
    }
    return { copied, already, failed };
  }
}
