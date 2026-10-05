import { Injectable } from "@nestjs/common";
import { normalizeFa, goodSearchText } from "../common/catalog/catalog";
import { refreshCatalogCount } from "../common/catalog/catalog-count";
import { provinceOf } from "../common/geo/cities";
import { CacheService, TTL } from "../common/cache/cache.module";
import { AppError } from "../common/errors/app-error";
import { t, type Locale } from "../common/i18n/i18n";
import { cursorBefore, decodeCursor, toPage } from "../common/pagination/cursor";
import { PrismaService } from "../common/prisma/prisma.module";
import { FilesService } from "../files/files.service";
import type { AuthUser } from "../common/decorators/auth.decorators";
import type { ImportRowInput } from "./import-file";

/**
 * ─── Products service ────────────────────────────────────────────────────────
 * The shared SKU identity layer (Good → Product → Listing).
 *
 * Growth engine (دقیقاً همان موتور رشد Good، یک پله عمیق‌تر):
 *   • find-or-create on every listing save — the second seller who types the
 *     same brand×spec CONVERGES to the first seller's Product instead of
 *     forking a new identity (قانون یکی بودن «مکنزی ۲۵۰گرمی» بین هم‌فروشنده‌ها)
 *   • no barcode in the typed form (v1) — identity is the normalized label;
 *     barcode arrives with scan/excel and is then the exact key
 *   • PROVISIONAL for ordinary users (same gardening contract as Good/Brand) —
 *     provisional rows stay usable everywhere; the admin merge tool is the
 *     cleanup, not a gate.
 */

/** Product row shape returned to the picker. */
export interface ProductRowDto {
  id: string;
  label: string;
  barcode: string | null;
  /** عکس مرجع محصول — اختیاری. در picker نشان داده می‌شود. */
  imageUrl: string | null;
  status: string;
  goodId: string;
  good: {
    id: string;
    nameFa: string;
    nameEn: string | null;
    unit: string;
    category: { id: string; slug: string; nameFa: string; nameEn: string };
  };
  brand: { id: string; name: string } | null;
  /** distinct businesses actively SELLING this exact SKU — the trust badge */
  sellers: number;
  /** null = the caller has no listing on this SKU; else their mode on it */
  mineMode: string | null;
}

/** A brand chip in the picker's horizontal brand strip — name + count. */
export interface BrandChipDto {
  id: string;
  name: string;
  /** number of products under this brand in the CURRENT filter scope */
  count: number;
}

/**
 * Picker page — items + the brand strip + the category chips, all derived
 * from the SAME filter scope (q, categoryId, goodId) EXCEPT brandId, so the
 * brand strip stays stable as the user toggles a brand on/off.
 */
export interface PickerPageDto {
  items: ProductRowDto[];
  nextCursor: string | null;
  /** total products matching the current filter scope (not just this page) */
  total: number;
  /** brands present in the current scope (q + categoryId + goodId),
   *  ranked by product count desc — powers the horizontal brand strip */
  brands: BrandChipDto[];
  /** leaf categories present in the current scope (q + brandId + goodId),
   *  ranked by product count desc — powers the optional category filter */
  categories: { id: string; nameFa: string; nameEn: string; count: number }[];
}

const PRODUCT_SELECT = {
  id: true,
  label: true,
  barcode: true,
  imageUrl: true,
  status: true,
  goodId: true,
  brandId: true,
  good: {
    select: {
      id: true,
      nameFa: true,
      nameEn: true,
      unit: true,
      category: { select: { id: true, slug: true, nameFa: true, nameEn: true } },
    },
  },
  brand: { select: { id: true, name: true } },
} as const;

/**
 * Deterministic identity text from what the seller already typed — brand +
 * attr VALUES in sorted-key order. This is the IDENTITY used for find-or-
 * create: two sellers entering the same brand + attr values produce the
 * SAME searchText → the same Product row (خواسته‌ی کاربر: «دوقلو نسازیم»).
 *
 * Sorted keys → two sellers entering specs in different order converge.
 *
 * NOTE: searchText is independent from label. Label is the user-facing
 * display name (e.g. «چیبس اشی مشی ۲۵۰ گرمی طعم پیاز» — human-friendly).
 * searchText is the machine identity (e.g. «اشي مشي 250g پیاز» — normalized,
 * order-insensitive). Two sellers can write different labels but if brand
 * + attrs match, they join the same Product.
 */
export function productIdentityParts(brandName: string | undefined, attrs: Record<string, string> | null): {
  label: string;
  searchText: string;
} | null {
  const parts: string[] = [];
  const brand = brandName?.trim();
  if (brand) parts.push(brand);
  if (attrs) for (const k of Object.keys(attrs).sort()) {
    const v = (attrs[k] ?? "").trim();
    if (v) parts.push(v);
  }
  if (parts.length === 0) return null; // plain unvarianted offer — bulk goods need no SKU identity
  const label = parts.join(" ").slice(0, 120);
  return { label, searchText: normalizeFa(label) };
}

/**
 * Build a human-friendly display label from Good name + brand + attrs.
 * Used as the DEFAULT label when the user hasn't typed one — the user can
 * still override it (خواسته‌ی کاربر: «عنوان محصول رو خود کاربر وارد کنه»).
 *
 * Example: goodName="چیبس", brand="اشی مشی", attrs={weight:"250g", flavor:"پیاز"}
 *        → "چیبس اشی مشی ۲۵۰ گرمی طعم پیاز"
 *
 * attrFaLabels maps attr keys (weight, flavor, ...) to their Persian label
 * suffix (گرمی, طعم, ...) so the auto-label reads naturally. Falls back
 * to just the value if no label is provided for that key.
 */
export function buildDisplayLabel(input: {
  goodName: string;
  brandName?: string;
  attrs: Record<string, string> | null;
  attrFaLabels?: Record<string, string>;
}): string {
  const parts: string[] = [input.goodName];
  const brand = input.brandName?.trim();
  if (brand) parts.push(brand);
  if (input.attrs) {
    for (const k of Object.keys(input.attrs).sort()) {
      const v = (input.attrs[k] ?? "").trim();
      if (!v) continue;
      const suffix = input.attrFaLabels?.[k];
      parts.push(suffix ? `${v} ${suffix}` : v);
    }
  }
  return parts.join(" ").slice(0, 120);
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly files: FilesService
  ) {}

  /**
   * Silent identity attach for saveListing — returns the Product the listing
   * belongs to (id + identity keys the listing upsert reuses as variantKey),
   * or null when the offer has no SKU-level identity (no brand, no attrs →
   * bulk/flee goods stay exactly on today's path).
   *
   * searchText is the machine identity (brand + sorted attr values, normalized).
   * label is the human-friendly display name — user can override it via
   * userLabel; if not provided, falls back to identity-based label.
   */
  async findOrCreateForListing(
    user: AuthUser,
    input: { goodId: string; brandId: string | null; brandName?: string; attrs: Record<string, string> | null; userLabel?: string; goodName?: string; locale: Locale }
  ): Promise<{ id: string; label: string; searchText: string } | null> {
    const identity = productIdentityParts(input.brandName, input.attrs);
    if (!identity) return null;

    const isAdmin = user.role === "ADMIN";

    // ── label: کاربر می‌تواند عنوان دلخواه بدهد؛ وگرنه از identity می‌سازیم
    // searchText همیشه از identity می‌آید — مهم برای find-or-create یکسان
    const label = (input.userLabel?.trim() || identity.label).slice(0, 120);

    // 1) exact normalized identity under the same good (barcode comes later
    //    with scan — when present it will be the FIRST lookup key here)
    const exact = await this.prisma.product.findFirst({
      where: {
        goodId: input.goodId,
        searchText: identity.searchText,
        status: { not: "MERGED" },
        ...(input.brandId ? { brandId: input.brandId } : {}),
      },
      select: { id: true, label: true, searchText: true },
    });
    if (exact) {
      // ── اگر کاربر عنوان جدید داده و محصول قبلاً با عنوان دیگری وجود دارد،
      // عنوان را به‌روز کن (ولی فقط اگر userLabel آمده باشد — نبود یعنی همان
      // عنوان قدیمی خوب است)
      if (input.userLabel?.trim() && exact.label !== label) {
        await this.prisma.product.update({
          where: { id: exact.id },
          data: { label },
          select: { id: true },
        });
        return { ...exact, label };
      }
      return exact;
    }

    // 2) convergence fallback — an identical searchText stored with a different
    //    (or null) brand row still joins; searchText is the identity
    const sameLabel = await this.prisma.product.findFirst({
      where: { goodId: input.goodId, searchText: identity.searchText, status: { not: "MERGED" } },
      select: { id: true, label: true, searchText: true },
      orderBy: { id: "asc" },
    });
    if (sameLabel) {
      if (input.userLabel?.trim() && sameLabel.label !== label) {
        await this.prisma.product.update({
          where: { id: sameLabel.id },
          data: { label },
          select: { id: true },
        });
        return { ...sameLabel, label };
      }
      return sameLabel;
    }

    const created = await this.prisma.product.create({
      data: {
        goodId: input.goodId,
        brandId: input.brandId,
        label,
        searchText: identity.searchText,
        status: isAdmin ? "ACTIVE" : "PROVISIONAL",
        creatorRole: isAdmin ? "ADMIN" : "USER",
        createdById: user.id,
      },
      select: { id: true, label: true, searchText: true },
    });
    // محصول تازه ساخته شد → کش صفحه‌ها/استریپ‌ها/شمارشِ پیکر باید تازه شود
    this.cache.invalidateTag("products");
    return created;
  }

  /**
   * Picker feed — browse/search the shared catalog. Every row carries the
   * two signals that make ticking feel safe: how many businesses already
   * sell it, and whether the caller already has it (داریش).
   *
   * Returns the page PLUS the brand strip + category strip — both derived
   * from the SAME filter scope EXCEPT the dimension they sit on, so the
   * strips stay stable as the user toggles a brand or category on/off.
   *
   * Productها فقط زمانی ساخته می‌شوند که کاربری Listing با برند/ویژگی ثبت
   * کند (findOrCreateForListing) یا ادمین در پنل بسازد. Good بدون Product
   * در picker دیده نمی‌شود — این عمدی است چون Product بدون برند بی‌معنی
   * است. منبع اصلی پر کردن کاتالوگ برای کاربر جدید، «کپی از هم‌صنف‌ها» است
   * (getAggregatedCatalog) که از Listingهای هم‌صنف‌ها تغذیه می‌شود.
   */
  async listForPicker(params: {
    q?: string;
    categoryId?: string;
    goodId?: string;
    brandId?: string;
    /** exact barcode hit — the scanner's indexed fast path */
    barcode?: string;
    /** caller's business for the «داریش» badge — omitted by the admin panel */
    businessId?: string;
    cursor?: string;
    limit?: number;
    hasImage?: string;
    status?: string;
  }): Promise<PickerPageDto> {
    const limit = Math.min(Math.max(params.limit ?? 40, 1), 100);
    const q = params.q?.trim();

    // اسکنر — بارکد کلیدِ دقیق است: یک ایندکس‌هیت، بدون فازِ جست‌وجوی متنی
    if (params.barcode) {
      const hit = await this.prisma.product.findFirst({
        where: { barcode: params.barcode, status: { not: "MERGED" } },
        select: PRODUCT_SELECT,
      });
      const items = hit ? await this.decoratePage([hit], params.businessId) : [];
      return { items, nextCursor: null, total: items.length, brands: [], categories: [] };
    }

    // فیلترهای پایه‌ی گروه کالا — داخل هر شاخه‌ی جست‌وجو می‌روند (فیلتر گودِ
    // سطح‌بالا + شاخه‌ی گودِ OR در یک کوئری، باگِ «$size must be an array»
    // مونگو را در $lookup تکراری پرایسما روشن می‌کند)
    //
    // 注意: قبلاً از relation filter `good: { category: { isActive: true } }` استفاده می‌کردیم
    // که با ۴۰هزار محصول در Prisma کند بود (۱۳ ثانیه). حالا فقط روی خود Product فیلتر می‌کنیم.
    // در پروداکشن دسته‌های فعال همیشه true هستن، پس این فیلتر عملاً همه را برمی‌گرداند.
    // اگر روزی نیاز به فیلتر بر اساس isActive شد، می‌توانیم با دو stage و lookup انجام دهیم.
    const goodIdFilter = params.goodId ? { goodId: params.goodId } : {};
    // ── شمارشِ کل نباید cursor را شامل شود (باگ قدیمی: total هنگام صفحه‌بندی کوچک می‌شد)
    const whereNoCursor: Record<string, unknown> = {
      status: params.status ? params.status : { not: "MERGED" },
      ...goodIdFilter,
      ...(params.brandId ? { brandId: params.brandId } : {}),
    };
    // فیلتر عکس — در هر دو where (با/بدون cursor) می‌نشیند
    if (params.hasImage === "yes") {
      whereNoCursor.imageUrl = { not: null };
    } else if (params.hasImage === "no") {
      whereNoCursor.imageUrl = null;
    }
    if (q) {
      // the typed word may describe the SKU («مکنزی ۲۵۰ گرم») or the class («تن ماهی»)
      // NOTE: قبلاً relation filter روی good.searchText داشتیم که کند بود.
      // حالا فقط روی Product.searchText فیلتر می‌کنیم — searchText محصول شامل نام good هم هست
      // چون موقع import از clean_name (که از good هست) استفاده شده.
      whereNoCursor.searchText = { contains: normalizeFa(q) };
    }
    const where: Record<string, unknown> = {
      ...whereNoCursor,
      ...cursorBefore(decodeCursor(params.cursor)),
    };
    let goodIdsForCat: string[] | null = null;
    if (params.categoryId) {
      // fetch goodIds for this category subtree first, then filter products
      const cats = await this.prisma.category.findMany({ select: { id: true, parentId: true } });
      const kidsOf = new Map<string, string[]>();
      for (const c of cats) {
        if (!c.parentId) continue;
        const arr = kidsOf.get(c.parentId);
        if (arr) arr.push(c.id);
        else kidsOf.set(c.parentId, [c.id]);
      }
      const categoryIds = [params.categoryId];
      const stack = [params.categoryId];
      while (stack.length) {
        const cur = stack.pop() as string;
        for (const kid of kidsOf.get(cur) ?? []) {
          categoryIds.push(kid);
          stack.push(kid);
        }
      }
      const goodsInCat = await this.prisma.good.findMany({
        where: { categoryId: { in: categoryIds } },
        select: { id: true },
      });
      const goodInFilter = { in: goodsInCat.map(g => g.id) };
      where.goodId = goodInFilter;
      // شمارشِ کل هم باید همان scope (شامل دسته) را ببیند — نه فقط صفحه‌ی فعلی
      whereNoCursor.goodId = goodInFilter;
      // Save the raw list for use in MongoDB aggregate (Prisma's { in: [...] } object
      // doesn't translate directly to MongoDB's { $in: [...] } — ObjectId conversion)
      goodIdsForCat = goodsInCat.map(g => g.id);
    }

    // ── کش و موازی‌سازی ───────────────────────────────────────────────────────
    // قبلاً این متد ۷ کوئریِ «متوالی» به Atlas می‌زد (از ایران هر کدام ۲۰۰ms+ =
    // بیش از ۲ ثانیه). حالا:
    //   • صفحه‌ی اصلی + شمارشِ فروشنده‌ها → کش ۶۰ثانیه‌ای (تگ products)
    //   • استریپ برند/دسته → کش ۵دقیقه‌ای (تگ products)
    //   • total → کش ۶۰ثانیه‌ای، بدون cursor (رفع باگ کوچک‌شدن total در صفحه‌بندی)
    //   • فقط «داریش» (mineMode) per-request می‌ماند چون به businessId فراخوان بستگی دارد
    // هر جهشِ ایمپورت/ادمین (importCommit، bulkCreate، adminEdit/Delete/Merge،
    // setProductImage) تگ products را باطل می‌کند.
    const scopeKey = `${q ?? ""}|${params.goodId ?? ""}|${params.categoryId ?? ""}|${params.brandId ?? ""}|${params.hasImage ?? ""}|${params.status ?? ""}`;
    const pageKey = `products:page:${scopeKey}|${params.cursor ?? ""}|${limit}`;
    const stripsKey = `products:strips:${q ?? ""}|${params.goodId ?? ""}|${params.categoryId ?? ""}`;
    const totalKey = `products:total:${scopeKey}`;
    const objectId = (hex: string): { $oid: string } => ({ $oid: hex });

    // ── صفحه: ردیف‌ها + شمارش فروشندگان (مشترک بین همه‌ی کاربران)
    const pageLoader = async (): Promise<{
      items: Omit<ProductRowDto, "sellers" | "mineMode">[];
      nextCursor: string | null;
      sellers: Record<string, number>;
    }> => {
      const rows = await this.prisma.product.findMany({
        where,
        select: PRODUCT_SELECT,
        orderBy: { id: "desc" },
        take: limit + 1,
      });
      const page = toPage(rows, limit);
      const ids = page.items.map((p) => p.id);
      const sellerCounts = ids.length > 0
        ? await this.prisma.listing.groupBy({
            by: ["productId"],
            where: { productId: { in: ids }, isActive: true, mode: { in: ["SELL", "BOTH"] }, priceMinor: { not: null } },
            _count: { _all: true },
          })
        : [];
      const sellers: Record<string, number> = {};
      for (const r of sellerCounts) {
        if (r.productId) sellers[r.productId] = r._count._all;
      }
      return { items: page.items, nextCursor: page.nextCursor, sellers };
    };

    // ── استریپ برند/دسته — از scope فعلی (بدون brandId تا با کلیک برند ثابت بمانند)
    const stripsLoader = async (): Promise<{ brands: BrandChipDto[]; categories: PickerPageDto["categories"] }> => {
      // از MongoDB aggregate مستقیم استفاده می‌کنیم — Prisma groupBy روی ۴۰هزار
      // محصول کند است (۳۰ ثانیه!) ولی MongoDB aggregate فقط ~۳۰۰ms.
      const goodIdFilter = goodIdsForCat
        ? { goodId: { $in: goodIdsForCat.map(objectId) } }
        : params.goodId ? { goodId: objectId(params.goodId) } : {};

      const brandAggPipeline = [
        { $match: { status: { $ne: "MERGED" }, brandId: { $ne: null, $exists: true }, ...goodIdFilter, ...(q ? { searchText: { $regex: normalizeFa(q), $options: "i" } } : {}) } },
        { $group: { _id: "$brandId", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 50 },
      ];
      const catAggPipeline = [
        { $match: { status: { $ne: "MERGED" }, ...goodIdFilter, ...(q ? { searchText: { $regex: normalizeFa(q), $options: "i" } } : {}) } },
        { $group: { _id: "$goodId", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 100 },
      ];

      const [brandAgg, catAgg] = await Promise.all([
        (this.prisma as unknown as { $runCommandRaw: (cmd: unknown) => Promise<unknown> })
          .$runCommandRaw({ aggregate: "Product", pipeline: brandAggPipeline, cursor: {} }),
        (this.prisma as unknown as { $runCommandRaw: (cmd: unknown) => Promise<unknown> })
          .$runCommandRaw({ aggregate: "Product", pipeline: catAggPipeline, cursor: {} }),
      ]);

      // brandAgg returns { cursor: { firstBatch: [...] } } — extract firstBatch
      // _id may be an ObjectId instance, an EJSON {$oid: "..."} object, or a string.
      // Normalize all three to a plain hex string for Prisma.
      function toHexId(v: unknown): string {
        if (!v) return "";
        if (typeof v === "string") return v;
        // EJSON extended JSON form: { $oid: "..." }
        if (typeof v === "object" && v !== null && "$oid" in v) return String((v as { $oid: string }).$oid);
        // ObjectId instance (has toString/toHexString)
        if (typeof v === "object" && v !== null && "toHexString" in v && typeof (v as { toHexString: () => string }).toHexString === "function") {
          return (v as { toHexString: () => string }).toHexString();
        }
        // Fallback — toString() on an ObjectId returns hex
        try { return String(v); } catch { return ""; }
      }
      const rawBrandGroups = (brandAgg as { cursor?: { firstBatch?: Array<{ _id: unknown; count: number }> } })?.cursor?.firstBatch ?? [];
      const rawCatGroups = (catAgg as { cursor?: { firstBatch?: Array<{ _id: unknown; count: number }> } })?.cursor?.firstBatch ?? [];
      const brandGroups = rawBrandGroups.map(g => ({ _id: toHexId(g._id), count: g.count }));
      const catGroups = rawCatGroups.map(g => ({ _id: toHexId(g._id), count: g.count }));

      // brandGroups only has _id (brandId) — fetch brand names + good rows in parallel
      const brandIds = brandGroups.map(g => g._id).filter(Boolean) as string[];
      const goodIds = catGroups.map(g => g._id).filter(Boolean) as string[];
      const [brandRows, goodRows] = await Promise.all([
        brandIds.length > 0
          ? this.prisma.brand.findMany({ where: { id: { in: brandIds } }, select: { id: true, name: true } })
          : Promise.resolve([] as { id: string; name: string }[]),
        goodIds.length > 0
          ? this.prisma.good.findMany({
              where: { id: { in: goodIds } },
              select: { id: true, categoryId: true, category: { select: { id: true, nameFa: true, nameEn: true } } },
            })
          : Promise.resolve([] as { id: string; categoryId: string; category: { id: string; nameFa: string; nameEn: string } }[]),
      ]);
      const brandNameMap = new Map(brandRows.map(b => [b.id, b.name]));
      const brands = brandGroups
        .map(g => ({ id: g._id!, name: brandNameMap.get(g._id!) ?? "نامشخص", count: g.count }))
        .filter(b => b.count > 0);

      const catCount = new Map<string, { id: string; nameFa: string; nameEn: string; count: number }>();
      const goodToCat = new Map(goodRows.map(g => [g.id, g.category]));
      for (const g of catGroups) {
        const cat = goodToCat.get(g._id);
        if (!cat) continue;
        const cur = catCount.get(cat.id);
        if (cur) cur.count += g.count;
        else catCount.set(cat.id, { id: cat.id, nameFa: cat.nameFa, nameEn: cat.nameEn ?? "", count: g.count });
      }
      const categories = [...catCount.values()].sort((a, b) => b.count - a.count).slice(0, 30);
      return { brands, categories };
    };

    // ── صفحه + استریپ‌ها + شمارش، همه موازی و زیر کش
    const [pageC, stripsC, totalC] = await Promise.all([
      this.cache.wrap(pageKey, { ttlMs: TTL.MINUTE, tags: ["products"] }, pageLoader),
      this.cache.wrap(stripsKey, { ttlMs: TTL.FIVE_MIN, tags: ["products"] }, stripsLoader),
      this.cache.wrap(totalKey, { ttlMs: TTL.MINUTE, tags: ["products"] }, async () =>
        this.prisma.product.count({ where: whereNoCursor })),
    ]);

    // ── «داریش» per-request ولی زیر کشِ ۳۰ثانیه‌ای per-business — نشانِ
    // داشتنِ خودِ کاربر به‌ندرت عوض می‌شود و saveListing همان لحظه تگ products
    // را باطل می‌کند. بدون این کش، هر تایپِ جست‌وجو یک رفت‌وبرگشت اضافه داشت.
    let mineMap = new Map<string, string>();
    if (params.businessId) {
      const { value: cachedMine } = await this.cache.wrap(
        `products:mine:${params.businessId}:${pageKey}`,
        { ttlMs: 30_000, tags: ["products"] },
        async () => {
          const mineRows = await this.prisma.listing.findMany({
            where: { businessId: params.businessId!, productId: { in: pageC.value.items.map((p) => p.id) }, isActive: true },
            select: { productId: true, mode: true },
          });
          return mineRows.map((m) => [m.productId!, m.mode] as [string, string]);
        }
      );
      mineMap = new Map(cachedMine);
    }
    const items = pageC.value.items.map((p) => ({
      ...p,
      sellers: pageC.value.sellers[p.id] ?? 0,
      mineMode: mineMap.get(p.id) ?? null,
    }));

    return {
      items,
      nextCursor: pageC.value.nextCursor,
      total: totalC.value,
      brands: stripsC.value.brands,
      categories: stripsC.value.categories,
    };
  }

  /** sellers-count + «داریش» for one page of product rows — two bounded aggregates */
  private async decoratePage(
    items: Omit<ProductRowDto, "sellers" | "mineMode">[],
    businessId?: string
  ): Promise<ProductRowDto[]> {
    const ids = items.map((p) => p.id);
    if (ids.length === 0) return items.map((p) => ({ ...p, sellers: 0, mineMode: null }));

    // sellers count — groupBy به‌جای distinct (سریع‌تر در MongoDB)
    const [sellerCounts, mineRows] = await Promise.all([
      this.prisma.listing.groupBy({
        by: ["productId"],
        where: { productId: { in: ids }, isActive: true, mode: { in: ["SELL", "BOTH"] }, priceMinor: { not: null } },
        _count: { _all: true },
      }).then((rows) => {
        const m = new Map<string, number>();
        for (const r of rows) { if (r.productId) m.set(r.productId, r._count._all); }
        return m;
      }),
      businessId
        ? this.prisma.listing.findMany({
            where: { businessId, productId: { in: ids }, isActive: true },
            select: { productId: true, mode: true },
          }).then((rows) => new Map(rows.map((m) => [m.productId!, m.mode])))
        : Promise.resolve(new Map<string, string>()),
    ]);

    return items.map((p) => ({
      ...p,
      sellers: sellerCounts.get(p.id) ?? 0,
      mineMode: mineRows.get(p.id) ?? null,
    }));
  }

  /**
   * Admin merge — the insurance that keeps the shared table healthy from day
   * one (خواسته‌ی کاربر: ابزار ادغام قبل از فیچر، نه بعدش). Minimal by design:
   * listings re-point to the survivor, merged rows keep an audit trail
   * (MERGED + mergedIntoId), barcode fills the survivor when missing.
   */
  async adminMerge(
    _user: AuthUser,
    input: { intoId: string; fromIds: string[]; locale: Locale }
  ): Promise<{ merged: number; intoId: string }> {
    const into = await this.prisma.product.findUnique({
      where: { id: input.intoId },
      select: { id: true, goodId: true, status: true, barcode: true },
    });
    if (!into || into.status === "MERGED") {
      throw AppError.badRequest(t(input.locale, "products.notFound", "محصول مرجع یافت نشد"), "PRODUCT_NOT_FOUND");
    }

    const froms = (
      await this.prisma.product.findMany({
        where: { id: { in: input.fromIds.filter((id) => id !== input.intoId) } },
        select: { id: true, goodId: true, barcode: true },
      })
    ).filter((f) => f.goodId === into.goodId); // cross-good merges are a Good-level merge, not this tool

    let survivor = into;
    let merged = 0;
    const affectedBusinesses = new Set<string>();

    for (const f of froms) {
      const moved = await this.prisma.listing.updateMany({
        where: { productId: f.id },
        data: { productId: survivor.id },
      });
      if (moved.count > 0) {
        const rows = await this.prisma.listing.findMany({
          where: { productId: survivor.id },
          select: { businessId: true },
          distinct: ["businessId"],
        });
        for (const r of rows) affectedBusinesses.add(r.businessId);
      }
      if (!survivor.barcode && f.barcode) {
        survivor = await this.prisma.product.update({
          where: { id: survivor.id },
          data: { barcode: f.barcode },
          select: { id: true, goodId: true, status: true, barcode: true },
        });
      }
      await this.prisma.product.update({
        where: { id: f.id },
        data: { status: "MERGED", mergedIntoId: survivor.id },
      });
      merged++;
    }

    // an admin-confirmed survivor is trusted — promote out of PROVISIONAL
    if (survivor.status !== "ACTIVE") {
      await this.prisma.product.update({ where: { id: survivor.id }, data: { status: "ACTIVE" } });
    }

    // reach every cached vitrine a re-pointed listing may appear on
    await this.bustBusinesses(affectedBusinesses);
    this.cache.invalidateTag("products");
    return { merged, intoId: survivor.id };
  }

  /** Cache tags of every view listings appear on — same contract as ListingsController.invalidateFor. */
  private async bustBusinesses(businessIds: Set<string>): Promise<void> {
    try {
      if (businessIds.size === 0) return;
      const rows = await this.prisma.business.findMany({
        where: { id: { in: [...businessIds] } },
        select: { id: true, slug: true },
      });
      for (const b of rows) {
        this.cache.invalidateTag(`business:slug:${b.slug}`);
        this.cache.invalidateTag(`business:${b.id}`);
        this.cache.invalidateTag(`market:board:${b.id}`);
        this.cache.invalidateTag(`market:home:${b.id}`);
        this.cache.invalidateTag(`market:sugg:${b.id}`);
        this.cache.invalidateTag(`market:ssugg:${b.id}`);
      }
    } catch {
      /* non-blocking */
    }
  }

  // ─── Excel/CSV import — همان موتور، در دیگری (خواسته‌ی کاربر: ایمپورت هنرمندانه) ──

  /** classification of one import row against the shared catalog */
  private async classifyImportRows(input: {
    businessId: string;
    mode: "SELL" | "BUY";
    rows: ImportRowInput[];
  }): Promise<
    {
      row: ImportRowInput;
      matchType: "product" | "good" | "new";
      goodId: string | null;
      goodName: string | null;
      goodUnit: string | null;
      productId: string | null;
      productLabel: string | null;
      identity: { label: string; searchText: string } | null;
      sellers: number;
      mineMode: string | null;
      /** which arms this row can land on — price → SELL, volume → BUY,
       * both → one BOTH row (خواسته‌ی کاربر: «فقط خرید؟ ستون‌های خرید رو پر کن» */
      arms: ("SELL" | "BUY")[];
      warning: string | null;
    }[]
  > {
    const { businessId, rows } = input;

    // ۱) good resolution for the whole file — batch the exact lookups first
    const goodNorms = [...new Set(rows.map((r) => normalizeFa(r.name)).filter(Boolean))];
    const goodRows = goodNorms.length
      ? await this.prisma.good.findMany({
          where: { searchText: { in: goodNorms } },
          select: { id: true, nameFa: true, unit: true, searchText: true },
        })
      : [];
    const goodByNorm = new Map(goodRows.map((g) => [g.searchText, g]));
    const missingNorms = goodNorms.filter((n) => !goodByNorm.has(n));
    // fuzzy fallback for the misses — one contains query per missing name (bounded by file size)
    for (const n of missingNorms) {
      const g = await this.prisma.good.findFirst({
        where: { searchText: { contains: n } },
        select: { id: true, nameFa: true, unit: true, searchText: true },
        orderBy: { id: "asc" },
      });
      if (g) goodByNorm.set(n, g);
    }

    // ۲) product identity per row (brand + spec, same engine as typed form)
    const identities = rows.map((r) => productIdentityParts(r.brand || undefined, r.spec ? { spec: r.spec } : null));

    // ۳) product matches for the whole file — one query per distinct identity under its good
    const productMap = new Map<string, { id: string; label: string; searchText: string }>();
    for (let i = 0; i < rows.length; i++) {
      const good = goodByNorm.get(normalizeFa(rows[i].name));
      const identity = identities[i];
      if (!good || !identity) continue;
      const key = `${good.id}|${identity.searchText}`;
      if (productMap.has(key)) continue;
      const exact = await this.prisma.product.findFirst({
        where: { goodId: good.id, searchText: identity.searchText, status: { not: "MERGED" } },
        select: { id: true, label: true, searchText: true },
        orderBy: { id: "asc" },
      });
      if (exact) productMap.set(key, exact);
    }

    // ۴) per-page aggregates for matched products — sellers count + «داریش»
    const matchedIds = [...new Set([...productMap.values()].map((p) => p.id))];
    const [sellRows, mine] = await Promise.all([
      matchedIds.length
        ? this.prisma.listing.findMany({
            where: { productId: { in: matchedIds }, isActive: true, mode: { in: ["SELL", "BOTH"] }, priceMinor: { not: null } },
            select: { productId: true, businessId: true },
            distinct: ["productId", "businessId"],
          })
        : Promise.resolve([] as { productId: string; businessId: string }[]),
      businessId
        ? this.prisma.listing.findMany({
            where: { businessId, productId: { in: matchedIds }, isActive: true },
            select: { productId: true, mode: true },
          })
        : Promise.resolve([] as { productId: string; mode: string }[]),
    ]);
    const sellers = new Map<string, number>();
    for (const r of sellRows) sellers.set(r.productId!, (sellers.get(r.productId!) ?? 0) + 1);
    const mineMap = new Map(mine.map((m) => [m.productId!, m.mode]));

    return rows.map((row, i) => {
      const good = goodByNorm.get(normalizeFa(row.name)) ?? null;
      const identity = identities[i];
      const product = good && identity ? productMap.get(`${good.id}|${identity.searchText}`) ?? null : null;
      const matchType: "product" | "good" | "new" = product ? "product" : good ? "good" : "new";
      const hasPrice = !!(row.priceMinor && row.priceMinor > 0);
      const hasVolume = !!(row.volume && row.volume > 0);
      const arms: ("SELL" | "BUY")[] = hasPrice && hasVolume ? ["SELL", "BUY"] : hasPrice ? ["SELL"] : hasVolume ? ["BUY"] : [];
      const warning =
        !normalizeFa(row.name)
          ? "noName"
          : arms.length === 0
            ? "noData"
            : null;
      return {
        row,
        matchType,
        goodId: good?.id ?? null,
        goodName: good?.nameFa ?? null,
        goodUnit: good?.unit ?? null,
        productId: product?.id ?? null,
        productLabel: product?.label ?? null,
        identity,
        sellers: product ? sellers.get(product.id) ?? 0 : 0,
        mineMode: product ? mineMap.get(product.id) ?? null : null,
        arms,
        warning,
      };
    });
  }

  /**
   * Preview of an import file — NOTHING is written. Every row comes back
   * classified (در کاتالوگ هست / گروه موجود / کاملاً جدید) so the user sees
   * exactly what will happen before confirming (خواسته‌ی کاربر: قابل فهم بودن).
   */
  async importPreview(input: { businessId: string; mode: "SELL" | "BUY"; rows: ImportRowInput[] }) {
    const classified = await this.classifyImportRows(input);
    const summary = {
      total: classified.length,
      matched: classified.filter((c) => c.matchType === "product").length,
      goodLevel: classified.filter((c) => c.matchType === "good").length,
      newGood: classified.filter((c) => c.matchType === "new").length,
      willSkip: classified.filter((c) => c.warning).length,
      withImage: classified.filter((c) => c.row.imageUrl).length,
    };
    return {
      summary,
      rows: classified.map((c) => ({
        index: c.row.index,
        name: c.row.name,
        brand: c.row.brand || null,
        spec: c.row.spec || null,
        priceMinor: c.row.priceMinor ?? null,
        stock: c.row.stock ?? null,
        minOrder: c.row.minOrder ?? null,
        volume: c.row.volume ?? null,
        hasImage: !!c.row.imageUrl,
        arms: c.arms,
        matchType: c.matchType,
        goodId: c.goodId,
        goodName: c.goodName,
        goodUnit: c.goodUnit,
        productId: c.productId,
        productLabel: c.productLabel,
        sellers: c.sellers,
        mineMode: c.mineMode,
        warning: c.warning,
        category: c.row.category || null,
        subcategory: c.row.subcategory || null,
      })),
    };
  }

  /**
   * Commit of an import file — the SAME engine as the typed form and the
   * picker: brand upsert, product find-or-create (silent), listing upsert
   * with the legacy fork-bridge. Per-row arms: قیمت → فروش، حجم → خرید،
   * هر دو → یک ردیف BOTH (خواسته‌ی کاربر: «فقط خرید؟ ستون‌های فروش رو خالی
   * بذار» — یک فایل، دو بازو). Rows without a matching reference good FAIL
   * with a clear reason — the import never invents categories (that is the
   * admin garden's job); one pass through the typed form adds the good for
   * everyone and the next import matches. Image URLs go through the same
   * gallery pipeline in the background — a slow or broken URL never blocks
   * the row (کالا بدون عکس ذخیره می‌شود، عکس بعداً خودش می‌نشیند).
   */
  async importCommit(
    user: AuthUser,
    input: { businessId: string; mode: "SELL" | "BUY"; rows: ImportRowInput[]; locale: Locale; replaceDuplicates?: boolean }
  ): Promise<{ saved: number; failed: number; skipped: { index: number; reason: string }[]; listingIds: string[] }> {
    const business = await this.prisma.business.findUnique({
      where: { id: input.businessId },
      select: { id: true, slug: true, city: true, province: true, country: true, currency: true },
    });
    if (!business) throw AppError.notFound("Business not found");

    const classified = await this.classifyImportRows({ businessId: business.id, mode: input.mode, rows: input.rows });
    const skipped: { index: number; reason: string }[] = [];
    let saved = 0;
    const listingIds: string[] = [];

    // legacy bridge — pre-product-layer rows holding the same offer keep
    // their gallery/history instead of spawning an imageless twin
    const batchGoodIds = [...new Set(classified.map((c) => c.goodId).filter((v): v is string => !!v))];
    const legacyRows = batchGoodIds.length
      ? await this.prisma.listing.findMany({
          where: { businessId: business.id, goodId: { in: batchGoodIds }, isActive: true, productId: null },
          select: { id: true, goodId: true, variantKey: true, attrs: true, brand: { select: { name: true } } },
        })
      : [];
    const legacyByKey = new Map<string, string>();
    for (const l of legacyRows) {
      const identity = productIdentityParts(l.brand?.name ?? undefined, (l.attrs as Record<string, string> | null) ?? null);
      const key = `${l.goodId}|${identity ? identity.searchText.slice(0, 60) : ""}`;
      if (!legacyByKey.has(key)) legacyByKey.set(key, l.id);
    }

    for (const c of classified) {
      const rowName = normalizeFa(c.row.name);
      if (!rowName) {
        skipped.push({ index: c.row.index, reason: "noName" });
        continue;
      }
      if (c.arms.length === 0) {
        skipped.push({ index: c.row.index, reason: "noData" });
        continue;
      }
      if (!c.goodId) {
        // Good پیدا نشد → یک Good جدید بساز. اگر ردیف اکسل category/subcategory
        // دارد، Good در دسته درست ساخته می‌شود. اگر نه، در «سایر › جدید».
        const newGoodId = await this.ensureGoodForImport(c.row.name, c.row.category, c.row.subcategory);
        if (newGoodId) {
          c.goodId = newGoodId;
          c.matchType = "new";
        } else {
          skipped.push({ index: c.row.index, reason: "goodNotFound" });
          continue;
        }
      }

      // گروه موجود ولی SKU جدید → محصول بی‌سروصدا ساخته می‌شود (همان لینک خاموش
      // فرم تایپی)؛ ردیفِ فلهٔ بدون برند/ویژگی بدون شناسه می‌ماند — همان مسیر امروز
      // اگه ردیف اکسل imageUrl دارد، روی Product ست می‌شود به‌عنوان عکس مرجع.
      let productId = c.productId;
      if (!productId && c.identity) {
        const brandId = c.row.brand ? await this.resolveBrandRow(user, c.row.brand) : null;
        const created = await this.prisma.product.create({
          data: {
            goodId: c.goodId,
            brandId,
            label: c.identity.label,
            searchText: c.identity.searchText,
            imageUrl: c.row.imageUrl ?? null,
            status: user.role === "ADMIN" ? "ACTIVE" : "PROVISIONAL",
            creatorRole: user.role === "ADMIN" ? "ADMIN" : "USER",
            createdById: user.id,
          },
          select: { id: true },
        });
        productId = created.id;
      }

      // حالت هر ردیف از محتوایش می‌آید — قیمت و حجم با هم = BOTH
      const rowMode = c.arms.includes("SELL") && c.arms.includes("BUY") ? "BOTH" : c.arms[0];
      const identityKey = c.identity?.searchText.slice(0, 60) ?? "";
      const hasPrice = !!(c.row.priceMinor && c.row.priceMinor > 0);
      const data = {
        mode: rowMode,
        brandId: c.row.brand ? await this.resolveBrandRow(user, c.row.brand) : null,
        productId: productId ?? null,
        attrs: c.row.spec ? { spec: c.row.spec } : null,
        variantKey: identityKey,
        variantLabel: c.identity?.label ?? c.row.name,
        isActive: true,
        city: business.city,
        province: business.province ?? provinceOf(business.city),
        country: business.country,
        priceMinor: hasPrice ? c.row.priceMinor! : null,
        currency: hasPrice ? business.currency : null,
        stock: hasPrice ? c.row.stock ?? 0 : null,
        minOrder: hasPrice ? c.row.minOrder ?? 1 : null,
        volume: c.row.volume ?? null,
        frequency: c.row.volume ? "MONTHLY" : null,
      };

      const legacyId = legacyByKey.get(`${c.goodId}|${identityKey}`) ?? legacyByKey.get(`${c.goodId}|`) ?? null;
      let listingId: string;

      // بررسی تکراری بودن — اگر کالای مرجع قبلاً در کاتالوگ کاربر هست
      // اگر replaceDuplicates=true → listing تکراری را آپدیت کن
      // اگر replaceDuplicates=false → در skipped با reason "duplicate" ثبت کن
      if (productId && !legacyId) {
        const existingListing = await this.prisma.listing.findFirst({
          where: {
            businessId: business.id,
            goodId: c.goodId,
            variantKey: identityKey,
            isActive: true,
          },
          select: { id: true },
        });
        if (existingListing) {
          if (input.replaceDuplicates) {
            // آپدیت listing تکراری با دیتای جدید
            try {
              await this.prisma.listing.update({ where: { id: existingListing.id }, data });
              listingIds.push(existingListing.id);
              saved++;
              continue;
            } catch {
              skipped.push({ index: c.row.index, reason: "duplicate" });
              continue;
            }
          } else {
            skipped.push({ index: c.row.index, reason: "duplicate" });
            continue;
          }
        }
      }

      try {
        if (legacyId) {
          listingId = legacyId;
          await this.prisma.listing.update({ where: { id: legacyId }, data });
        } else {
          const row = await this.prisma.listing.upsert({
            where: {
              businessId_goodId_variantKey: {
                businessId: business.id,
                goodId: c.goodId,
                variantKey: identityKey,
              },
            },
            create: { businessId: business.id, goodId: c.goodId, ...data },
            update: data,
            select: { id: true },
          });
          listingId = row.id;
        }
        saved++;
        listingIds.push(listingId);
        if (c.row.imageUrl) {
          void this.files.ingestUrl(
            user,
            { model: "Listing", modelId: listingId, fieldKey: "gallery", replace: false },
            c.row.imageUrl,
            () => this.bustBusinesses(new Set([business.id]))
          );
        }
      } catch {
        skipped.push({ index: c.row.index, reason: "conflict" });
      }
    }

    if (saved > 0) {
      this.bustBusinesses(new Set([business.id]));
      this.cache.invalidateTag("products");
      void refreshCatalogCount(this.prisma, business.id);
    }
    return { saved, failed: skipped.length, skipped, listingIds };
  }

  /** brand free-text → deduped Brand row (same contract as saveListing) */
  /**
   * Ensure a Good exists for an import row whose name didn't match any
   * existing Good. Creates it under the right category:
   *   • اگر category و subcategory داده شده → دسته را پیدا کن یا بساز.
   *   • اگر فقط category داده شده → Good در category اصلی.
   *   • اگر هیچ‌کدام نیست → در «سایر › جدید» (fallback).
   *
   * Category/subcategory از روی نام (normalized) پیدا می‌شوند. اگر دسته‌ای
   * با آن نام نیست، ساخته می‌شود — به‌عنوان root اگر parent نیست، یا به‌عنوان
   * child اگر parent هست.
   *
   * Returns the Good id, or null if creation failed.
   */
  private async ensureGoodForImport(
    name: string,
    category?: string | null,
    subcategory?: string | null,
  ): Promise<string | null> {
    const trimmed = name.trim();
    if (trimmed.length < 2) return null;

    const searchText = goodSearchText({ nameFa: trimmed });

    // اگر قبلاً ساخته شده (مثلاً در همین batch)، برگردان
    const existing = await this.prisma.good.findFirst({
      where: { searchText },
      select: { id: true },
    });
    if (existing) return existing.id;

    try {
      // تعیین categoryId بر اساس category/subcategory
      let categoryId: string;

      if (category && category.trim()) {
        const catName = category.trim();
        const catNorm = normalizeFa(catName);

        // جستجوی category (هم nameFa هم slug)
        let cat = await this.prisma.category.findFirst({
          where: {
            OR: [
              { nameFa: catName },
              { slug: catNorm },
              { nameEn: catName },
            ],
          },
          select: { id: true },
        });

        if (!cat) {
          // دسته وجود ندارد → ساخته می‌شود به‌عنوان root (parentId = null)
          cat = await this.prisma.category.create({
            data: {
              slug: catNorm.slice(0, 40),
              nameFa: catName.slice(0, 40),
              nameEn: catName.slice(0, 40),
              isActive: true,
              unit: "PIECE",
            },
            select: { id: true },
          });
        }

        if (subcategory && subcategory.trim()) {
          const subName = subcategory.trim();
          const subNorm = normalizeFa(subName);

          // جستجوی subcategory زیر این category
          let sub = await this.prisma.category.findFirst({
            where: {
              parentId: cat.id,
              OR: [
                { nameFa: subName },
                { slug: subNorm },
                { nameEn: subName },
              ],
            },
            select: { id: true },
          });

          if (!sub) {
            // زیردسته وجود ندارد → ساخته می‌شود زیر category
            sub = await this.prisma.category.create({
              data: {
                slug: subNorm.slice(0, 40),
                nameFa: subName.slice(0, 40),
                nameEn: subName.slice(0, 40),
                parentId: cat.id,
                isActive: true,
                unit: "PIECE",
              },
              select: { id: true },
            });
          }

          categoryId = sub.id;
        } else {
          // فقط category، بدون subcategory → Good در category اصلی
          categoryId = cat.id;
        }
      } else {
        // هیچ category داده نشده → «سایر › جدید» (fallback)
        const root = await this.prisma.category.upsert({
          where: { slug: "sayer" },
          create: { slug: "sayer", nameFa: "سایر", nameEn: "Other", isActive: true, unit: null },
          update: {},
          select: { id: true },
        });
        const leaf = await this.prisma.category.upsert({
          where: { slug: "jadid" },
          create: {
            slug: "jadid",
            nameFa: "جدید",
            nameEn: "New",
            parentId: root.id,
            unit: "PIECE",
            isActive: true,
          },
          update: { parentId: root.id, isActive: true },
          select: { id: true, unit: true },
        });
        categoryId = leaf.id;
      }

      const created = await this.prisma.good.create({
        data: {
          categoryId,
          nameFa: trimmed.slice(0, 80),
          nameEn: null,
          aliases: [],
          searchText,
          unit: "PIECE",
          source: "USER",
          status: "PROVISIONAL",
          creatorRole: "USER",
        },
        select: { id: true },
      });
      this.cache.invalidateTag("goods");
      return created.id;
    } catch {
      return null;
    }
  }

  private async resolveBrandRow(user: AuthUser, name: string): Promise<string | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const searchText = goodSearchText({ nameFa: trimmed });
    const isAdmin = user.role === "ADMIN";
    const brand = await this.prisma.brand.upsert({
      where: { searchText },
      create: {
        name: trimmed.slice(0, 60),
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

  /**
   * ست کردن عکس مرجع Product — وقتی کاربر برای کالای مرجعی که عکس ندارد
   * عکس آپلود می‌کند، آن عکس روی Product.imageUrl ست می‌شود تا از آن به بعد
   * در لیست مرجع دیده شود (خواسته‌ی کاربر: عکس کاربر روی مرجع ثبت شود).
   * اگر Product قبلاً عکس دارد، عکس جدید جایگزین نمی‌شود.
   */
  async setProductImage(
    _user: AuthUser,
    input: { productId: string; imageUrl: string }
  ): Promise<{ ok: boolean }> {
    const product = await this.prisma.product.findUnique({
      where: { id: input.productId },
      select: { id: true, imageUrl: true },
    });
    if (!product) throw AppError.notFound("Product not found");
    // فقط اگر عکس ندارد ست کن — عکس قبلی را بازنویسی نکن
    if (product.imageUrl) return { ok: true };
    await this.prisma.product.update({
      where: { id: product.id },
      data: { imageUrl: input.imageUrl },
    });
    this.cache.invalidateTag("goods");
    this.cache.invalidateTag("products");
    return { ok: true };
  }
}
