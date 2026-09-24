import { Injectable } from "@nestjs/common";
import { normalizeFa } from "../common/catalog/catalog";
import { CacheService } from "../common/cache/cache.module";
import { AppError } from "../common/errors/app-error";
import { t, type Locale } from "../common/i18n/i18n";
import { cursorBefore, decodeCursor, toPage, type Page } from "../common/pagination/cursor";
import { PrismaService } from "../common/prisma/prisma.module";
import type { AuthUser } from "../common/decorators/auth.decorators";

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
  status: string;
  goodId: string;
  good: {
    id: string;
    nameFa: string;
    nameEn: string | null;
    unit: string;
    category: { id: string; slug: string; nameFa: string; nameEn: string };
  };
  brand: { name: string } | null;
  /** distinct businesses actively SELLING this exact SKU — the trust badge */
  sellers: number;
  /** null = the caller has no listing on this SKU; else their mode on it */
  mineMode: string | null;
}

const PRODUCT_SELECT = {
  id: true,
  label: true,
  barcode: true,
  status: true,
  goodId: true,
  good: {
    select: {
      id: true,
      nameFa: true,
      nameEn: true,
      unit: true,
      category: { select: { id: true, slug: true, nameFa: true, nameEn: true } },
    },
  },
  brand: { select: { name: true } },
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
    private readonly cache: CacheService
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
   */
  async listForPicker(params: {
    q?: string;
    categoryId?: string;
    goodId?: string;
    businessId: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<ProductRowDto>> {
    const limit = Math.min(Math.max(params.limit ?? 40, 1), 100);
    const q = params.q?.trim();

    const goodWhere: Record<string, unknown> = { category: { isActive: true } };
    if (params.goodId) goodWhere.id = params.goodId;
    else if (params.categoryId) goodWhere.categoryId = params.categoryId;

    const where: Record<string, unknown> = {
      status: { not: "MERGED" },
      good: goodWhere,
      ...cursorBefore(decodeCursor(params.cursor)),
    };
    if (q) {
      // the typed word may describe the SKU («مکنزی ۲۵۰ گرم») or the class («تن ماهی»)
      where.OR = [
        { searchText: { contains: normalizeFa(q) } },
        { good: { searchText: { contains: normalizeFa(q) } } },
      ];
    }

    const rows = await this.prisma.product.findMany({
      where,
      select: PRODUCT_SELECT,
      orderBy: { id: "desc" },
      take: limit + 1,
    });
    const page = toPage(rows as (ProductRowDto & { brand: { name: string } | null })[], limit);

    // ── per-page aggregates: exact distinct-seller counts + «داریش» flags ──
    const ids = page.items.map((p) => p.id);
    const [sellRows, mine] = await Promise.all([
      ids.length
        ? this.prisma.listing.findMany({
            where: { productId: { in: ids }, isActive: true, mode: { in: ["SELL", "BOTH"] }, priceMinor: { not: null } },
            select: { productId: true, businessId: true },
            distinct: ["productId", "businessId"],
          })
        : Promise.resolve([] as { productId: string; businessId: string }[]),
      ids.length
        ? this.prisma.listing.findMany({
            where: { businessId: params.businessId, productId: { in: ids }, isActive: true },
            select: { productId: true, mode: true },
          })
        : Promise.resolve([] as { productId: string; mode: string }[]),
    ]);

    const sellers = new Map<string, number>();
    for (const r of sellRows) sellers.set(r.productId!, (sellers.get(r.productId!) ?? 0) + 1);
    const mineMap = new Map(mine.map((m) => [m.productId!, m.mode]));

    return {
      ...page,
      items: page.items.map((p) => ({ ...p, sellers: sellers.get(p.id) ?? 0, mineMode: mineMap.get(p.id) ?? null })),
    };
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
}
