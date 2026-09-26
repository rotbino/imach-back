import { Injectable } from "@nestjs/common";
import { normalizeFa, goodSearchText } from "../common/catalog/catalog";
import { refreshCatalogCount } from "../common/catalog/catalog-count";
import { provinceOf } from "../common/geo/cities";
import { CacheService } from "../common/cache/cache.module";
import { AppError } from "../common/errors/app-error";
import { t, type Locale } from "../common/i18n/i18n";
import { cursorBefore, decodeCursor, toPage, type Page } from "../common/pagination/cursor";
import { PrismaService } from "../common/prisma/prisma.module";
import { FilesService } from "../files/files.service";
import type { AuthUser } from "../common/decorators/auth.decorators";
import type { ImportRow, ImportRowInput } from "./import-file";

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
 * attr VALUES in sorted-key order (خواسته‌ی کاربر: هیچ فیلد و قدم جدیدی در
 * فرم نیست؛ همان برند/ویژگی‌های امروز به یک رکورد مشترک وصل می‌شود).
 * Sorted keys → two sellers entering specs in different order converge.
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
   */
  async findOrCreateForListing(
    user: AuthUser,
    input: { goodId: string; brandId: string | null; brandName?: string; attrs: Record<string, string> | null; locale: Locale }
  ): Promise<{ id: string; label: string; searchText: string } | null> {
    const identity = productIdentityParts(input.brandName, input.attrs);
    if (!identity) return null;

    const isAdmin = user.role === "ADMIN";

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
    if (exact) return exact;

    // 2) convergence fallback — an identical label stored with a different
    //    (or null) brand row still joins; labels are the v1 identity
    const sameLabel = await this.prisma.product.findFirst({
      where: { goodId: input.goodId, searchText: identity.searchText, status: { not: "MERGED" } },
      select: { id: true, label: true, searchText: true },
      orderBy: { id: "asc" },
    });
    if (sameLabel) return sameLabel;

    const created = await this.prisma.product.create({
      data: {
        goodId: input.goodId,
        brandId: input.brandId,
        label: identity.label,
        searchText: identity.searchText,
        status: isAdmin ? "ACTIVE" : "PROVISIONAL",
        creatorRole: isAdmin ? "ADMIN" : "USER",
        createdById: user.id,
      },
      select: { id: true, label: true, searchText: true },
    });
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
      return { items, nextCursor: null, brands: [], categories: [] };
    }

    // فیلترهای پایه‌ی گروه کالا — داخل هر شاخه‌ی جست‌وجو می‌روند (فیلتر گودِ
    // سطح‌بالا + شاخه‌ی گودِ OR در یک کوئری، باگِ «$size must be an array»
    // مونگو را در $lookup تکراری پرایسما روشن می‌کند)
    const goodBase: Record<string, unknown> = {
      category: { isActive: true },
      ...(params.goodId ? { id: params.goodId } : {}),
      ...(params.categoryId ? { categoryId: params.categoryId } : {}),
    };
    const where: Record<string, unknown> = {
      status: { not: "MERGED" },
      ...(params.brandId ? { brandId: params.brandId } : {}),
      ...cursorBefore(decodeCursor(params.cursor)),
    };
    if (q) {
      // the typed word may describe the SKU («مکنزی ۲۵۰ گرم») or the class («تن ماهی»)
      where.OR = [
        { searchText: { contains: normalizeFa(q) }, good: goodBase },
        { good: { ...goodBase, searchText: { contains: normalizeFa(q) } } },
      ];
    } else {
      where.good = goodBase;
    }

    const rows = await this.prisma.product.findMany({
      where,
      select: PRODUCT_SELECT,
      orderBy: { id: "desc" },
      take: limit + 1,
    });
    const page = toPage(rows, limit);
    const decorated = await this.decoratePage(page.items, params.businessId);

    // ── نوار برند — برندِ همه‌ی محصول‌هایی که در scope فعلی هستن (بدون فیلتر برند).
    // با انتخاب برند، نوار ثابت می‌ماند تا کاربر برند را بداند عوض کنه.
    const brandScopeWhere: Record<string, unknown> = {
      status: { not: "MERGED" },
      ...(params.goodId ? { goodId: params.goodId } : {}),
      ...(params.categoryId ? { good: { ...goodBase } } : {}),
    };
    if (q) {
      brandScopeWhere.OR = [
        { searchText: { contains: normalizeFa(q) }, good: goodBase },
        { good: { ...goodBase, searchText: { contains: normalizeFa(q) } } },
      ];
    } else {
      brandScopeWhere.good = goodBase;
    }
    const brandRows = await this.prisma.product.findMany({
      where: brandScopeWhere,
      select: { brandId: true, brand: { select: { id: true, name: true } } },
      take: 500,
    });
    const brandCount = new Map<string, { id: string; name: string; count: number }>();
    for (const r of brandRows) {
      if (!r.brand) continue;
      const cur = brandCount.get(r.brand.id);
      if (cur) cur.count += 1;
      else brandCount.set(r.brand.id, { id: r.brand.id, name: r.brand.name, count: 1 });
    }
    const brands = [...brandCount.values()].sort((a, b) => b.count - a.count).slice(0, 30);

    // ── نوار دسته — از همان scope، با brandId اعمال شده (دسته بر اساس برند فعلی)
    const catScopeWhere: Record<string, unknown> = {
      status: { not: "MERGED" },
      ...(params.brandId ? { brandId: params.brandId } : {}),
      ...(params.goodId ? { goodId: params.goodId } : {}),
    };
    if (q) {
      catScopeWhere.OR = [
        { searchText: { contains: normalizeFa(q) } },
        { good: { ...goodBase, searchText: { contains: normalizeFa(q) } } },
      ];
    } else {
      catScopeWhere.good = goodBase;
    }
    const catRows = await this.prisma.product.findMany({
      where: catScopeWhere,
      select: { good: { select: { category: { select: { id: true, nameFa: true, nameEn: true } } } } },
      take: 500,
    });
    const catCount = new Map<string, { id: string; nameFa: string; nameEn: string; count: number }>();
    for (const r of catRows) {
      const c = r.good?.category;
      if (!c) continue;
      const cur = catCount.get(c.id);
      if (cur) cur.count += 1;
      else catCount.set(c.id, { id: c.id, nameFa: c.nameFa, nameEn: c.nameEn, count: 1 });
    }
    const categories = [...catCount.values()].sort((a, b) => b.count - a.count).slice(0, 20);

    return { ...page, items: decorated, brands, categories };
  }

  /** sellers-count + «داریش» for one page of product rows — two bounded aggregates */
  private async decoratePage(
    items: Omit<ProductRowDto, "sellers" | "mineMode">[],
    businessId?: string
  ): Promise<ProductRowDto[]> {
    const ids = items.map((p) => p.id);
    const [sellRows, mine] = await Promise.all([
      ids.length
        ? this.prisma.listing.findMany({
            where: { productId: { in: ids }, isActive: true, mode: { in: ["SELL", "BOTH"] }, priceMinor: { not: null } },
            select: { productId: true, businessId: true },
            distinct: ["productId", "businessId"],
          })
        : Promise.resolve([] as { productId: string; businessId: string }[]),
      ids.length && businessId
        ? this.prisma.listing.findMany({
            where: { businessId, productId: { in: ids }, isActive: true },
            select: { productId: true, mode: true },
          })
        : Promise.resolve([] as { productId: string; mode: string }[]),
    ]);
    const sellers = new Map<string, number>();
    for (const r of sellRows) sellers.set(r.productId!, (sellers.get(r.productId!) ?? 0) + 1);
    const mineMap = new Map(mine.map((m) => [m.productId!, m.mode]));
    return items.map((p) => ({ ...p, sellers: sellers.get(p.id) ?? 0, mineMode: mineMap.get(p.id) ?? null }));
  }

  /**
   * Admin merge — the insurance that keeps the shared table healthy from day
   * one (خواسته‌ی کاربر: ابزار ادغام قبل از فیچر، نه بعدش). Minimal by design:
   * listings re-point to the survivor, merged rows keep an audit trail
   * (MERGED + mergedIntoId), barcode fills the survivor when missing.
   */
  async adminMerge(
    user: AuthUser,
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
    input: { businessId: string; mode: "SELL" | "BUY"; rows: ImportRowInput[]; locale: Locale }
  ): Promise<{ saved: number; failed: number; skipped: { index: number; reason: string }[] }> {
    const business = await this.prisma.business.findUnique({
      where: { id: input.businessId },
      select: { id: true, slug: true, city: true, province: true, country: true, currency: true },
    });
    if (!business) throw AppError.notFound("Business not found");

    const classified = await this.classifyImportRows({ businessId: business.id, mode: input.mode, rows: input.rows });
    const skipped: { index: number; reason: string }[] = [];
    let saved = 0;

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

      // بررسی تکراری بودن — اگر کالای مرجع (productId) قبلاً در کاتالوگ کاربر هست
      // و کاربر قبلاً آن را ثبت کرده، تکراری است. به‌جای update خودکار،
      // در skipped با reason "duplicate" ثبت می‌شود تا فرانت به کاربر نشان دهد.
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
          skipped.push({ index: c.row.index, reason: "duplicate" });
          continue;
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
      void refreshCatalogCount(this.prisma, business.id);
    }
    return { saved, failed: skipped.length, skipped };
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
}
