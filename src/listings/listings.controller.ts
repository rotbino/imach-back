import { Body, Controller, Delete, Get, Param, Put, Query, UseGuards } from "@nestjs/common";
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
import { ProductsService } from "../products/products.service";
import { BulkSaveDto } from "../products/dto/product.dto";
import { SaveListingDto } from "./dto/listing.dto";

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

    const unique = { businessId_goodId_variantKey: { businessId: business.id, goodId: body.goodId, variantKey: productIdentity ? productIdentity.searchText.slice(0, 60) : variantKey } };
    const existing = await this.prisma.listing.findUnique({
      where: unique,
      select: { id: true, priceMinor: true },
    });

    const listing = await this.prisma.listing.upsert({
      where: unique,
      create: { businessId: business.id, goodId: body.goodId, ...data },
      update: data,
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
    });

    if (
      existing &&
      existing.priceMinor !== null &&
      listing.priceMinor !== null &&
      existing.priceMinor !== listing.priceMinor
    ) {
      await this.prisma.priceLog.create({
        data: { listingId: listing.id, oldMinor: existing.priceMinor, newMinor: listing.priceMinor },
      });
    }

    this.invalidateFor(business.id, business.slug);
    return listing;
  }

  /**
   * PUT /listings/bulkSave — one picker confirmation → N listings
   * (خواسته‌ی کاربر: فروشنده‌ی پرقلم تیک می‌زند، قیمت‌ها را در یک جدول فشرده
   * پر می‌کند، یک‌جا ثبت می‌کند). Same upsert contract as saveListing with
   * variantKey="" — the plain offer of each picked Product.
   * BUY rows MAY omit volume — the buy list forms gradually («تیک بزن،
   * مقدارش را بعداً بده») and shows them with a «مقدار بعداً» badge.
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

    for (const item of body.items) {
      const p = productMap.get(item.productId);
      if (!p || p.status === "MERGED") {
        failed++;
        continue;
      }
      if (body.mode === "SELL" && !(item.priceMinor && item.priceMinor > 0)) {
        failed++; // picker UI enforces price — this is the API safety net
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
        ...(body.mode === "SELL"
          ? {
              priceMinor: item.priceMinor!,
              currency: business.currency,
              stock: item.stock ?? 0,
              minOrder: item.minOrder ?? 1,
              volume: null,
              frequency: null,
            }
          : {
              priceMinor: null,
              currency: null,
              stock: null,
              minOrder: null,
              volume: item.volume ?? null,
              frequency: item.frequency ?? "MONTHLY",
            }),
      };
      const unique = { businessId_goodId_variantKey: { businessId: business.id, goodId: p.goodId, variantKey: p.searchText.slice(0, 60) } };
      const row = await this.prisma.listing.upsert({
        where: unique,
        create: { businessId: business.id, goodId: p.goodId, ...data },
        update: data,
        select: { id: true },
      });
      saved++;
      savedRows.push({ productId: p.id, listingId: row.id });
    }

    if (saved > 0) this.invalidateFor(business.id, business.slug);
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
    return { ok: true };
  }
}
