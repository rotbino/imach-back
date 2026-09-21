import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { goodSearchText, normalizeFa } from "../common/catalog/catalog";
import { CacheService } from "../common/cache/cache.module";
import { CurrentLocale } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import { t, type Locale } from "../common/i18n/i18n";
import { cursorBefore, decodeCursor, toPage, type Page } from "../common/pagination/cursor";
import { PrismaService } from "../common/prisma/prisma.module";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  AdminBrandsQueryDto,
  AdminCreateGoodDto,
  AdminEditGoodDto,
  AdminGoodsQueryDto,
  AdminMergeDto,
} from "./dto/admin.dto";
import { AdminGuard } from "./admin.guard";

/**
 * ─── Admin surface ──────────────────────────────────────────────────────────
 * Physically separated folder (src/admin/**) so that one day it can be lifted
 * into its own deployable without touching feature modules. Everything here
 * sits behind [JwtAuthGuard + AdminGuard]: any user whose role is ADMIN can
 * use the panel — no separate app, no separate login.
 *
 * Scope v1: catalog gardening for reference goods + brands
 *   • stats      — a handful of counters for the overview page
 *   • goods      — search/browse the catalog with live listing counts
 *   • edit/approve/rename/re-unit/re-home a good (PROVISIONAL → ACTIVE)
 *   • merge      — converge duplicates: listings move, names become aliases
 *   • delete     — only empty goods; anything with listings must merge first
 *   • brands     — same gardening for auto-resolved brands
 *
 * Every mutation invalidates the "goods" cache tag so the public catalog and
 * the listing form reflect the garden the moment it is pruned.
 */

const ADMIN_GOOD_SELECT = {
  id: true,
  nameFa: true,
  nameEn: true,
  aliases: true,
  unit: true,
  source: true,
  status: true,
  category: { select: { id: true, slug: true, nameFa: true, nameEn: true } },
  _count: { select: { listings: true } },
} as const;

type AdminGoodRow = {
  id: string;
  nameFa: string;
  nameEn: string | null;
  aliases: string[];
  unit: string;
  source: string;
  status: string;
  category: { id: string; slug: string; nameFa: string; nameEn: string };
  _count: { listings: number };
};

@Controller("admin")
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService
  ) {}

  // ── Overview ──────────────────────────────────────────────────────────────

  @Get("getStats")
  async getStats() {
    const [goods, provisional, userGoods, listings, businesses, users, brands, buyListings] =
      await Promise.all([
        this.prisma.good.count(),
        this.prisma.good.count({ where: { status: "PROVISIONAL" } }),
        this.prisma.good.count({ where: { source: "USER" } }),
        this.prisma.listing.count(),
        this.prisma.business.count(),
        this.prisma.user.count(),
        this.prisma.brand.count(),
        this.prisma.listing.count({ where: { mode: "BUY" } }),
      ]);
    return { goods, provisional, userGoods, listings, buyListings, businesses, users, brands };
  }

  // ── Reference goods gardening ────────────────────────────────────────────

  @Get("getGoods")
  async getGoods(@Query() q: AdminGoodsQueryDto): Promise<Page<AdminGoodRow>> {
    const limit = Math.min(Math.max(q.limit ?? 30, 1), 100);
    const text = q.q?.trim();

    const rows = await this.prisma.good.findMany({
      where: {
        ...(text ? { searchText: { contains: normalizeFa(text) } } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.source ? { source: q.source } : {}),
        ...(!text && q.categoryId ? { categoryId: q.categoryId } : {}),
        ...cursorBefore(decodeCursor(q.cursor)),
      },
      select: ADMIN_GOOD_SELECT,
      orderBy: { id: "desc" },
      take: limit + 1,
    });
    return toPage(rows, limit);
  }

  @Post("createGood")
  async createGood(@Body() body: AdminCreateGoodDto, @CurrentLocale() locale: Locale) {
    const category = await this.prisma.category.findUnique({
      where: { id: body.categoryId },
      select: { id: true },
    });
    if (!category) throw AppError.badRequest(t(locale, "catalog.categoryNotFound", "دسته‌بندی یافت نشد"), "CATEGORY_NOT_FOUND");

    const aliases = (body.aliases ?? []).map((a) => a.trim()).filter(Boolean);
    const searchText = goodSearchText({ nameFa: body.nameFa, nameEn: body.nameEn, aliases });
    const dup = await this.prisma.good.findFirst({ where: { searchText }, select: { id: true } });
    if (dup) throw AppError.conflict(t(locale, "admin.goodExists", "کالای مرجعی با همین نام وجود دارد"), "GOOD_EXISTS");

    const created = await this.prisma.good.create({
      data: {
        categoryId: body.categoryId,
        nameFa: body.nameFa.trim(),
        nameEn: body.nameEn?.trim() || null,
        aliases,
        searchText,
        unit: body.unit,
        source: "SEED",
        status: "ACTIVE",
      },
      select: ADMIN_GOOD_SELECT,
    });
    this.cache.invalidateTag("goods");
    return created;
  }

  @Patch("editGood/:id")
  async editGood(
    @Param("id") id: string,
    @Body() body: AdminEditGoodDto,
    @CurrentLocale() locale: Locale
  ) {
    const row = await this.prisma.good.findUnique({
      where: { id },
      select: { id: true, nameFa: true, nameEn: true, aliases: true, categoryId: true },
    });
    if (!row) throw AppError.notFound(t(locale, "admin.goodNotFound", "کالای مرجع یافت نشد"));

    if (body.categoryId && body.categoryId !== row.categoryId) {
      const cat = await this.prisma.category.findUnique({
        where: { id: body.categoryId },
        select: { id: true },
      });
      if (!cat) throw AppError.badRequest(t(locale, "catalog.categoryNotFound", "دسته‌بندی یافت نشد"), "CATEGORY_NOT_FOUND");
    }

    const nameFa = body.nameFa?.trim() ?? row.nameFa;
    const nameEn = body.nameEn !== undefined ? body.nameEn.trim() || null : row.nameEn;
    const aliases = body.aliases
      ? body.aliases.map((a) => a.trim()).filter(Boolean).slice(0, 10)
      : row.aliases;

    const updated = await this.prisma.good.update({
      where: { id },
      data: {
        nameFa,
        nameEn,
        aliases,
        ...(body.unit ? { unit: body.unit } : {}),
        ...(body.categoryId ? { categoryId: body.categoryId } : {}),
        ...(body.status ? { status: body.status } : {}),
        searchText: goodSearchText({ nameFa, nameEn, aliases }),
      },
      select: ADMIN_GOOD_SELECT,
    });
    this.cache.invalidateTag("goods");
    return updated;
  }

  /**
   * Merge a good into a target: every listing is re-pointed, the source's
   * names survive as aliases on the target (so old searches keep hitting),
   * and the empty source row is deleted. One round of gardening, zero data loss.
   */
  @Post("mergeGood/:id")
  async mergeGood(
    @Param("id") id: string,
    @Body() body: AdminMergeDto,
    @CurrentLocale() locale: Locale
  ) {
    if (id === body.targetId) {
      throw AppError.badRequest(t(locale, "admin.mergeSelf", "ادغام کالا با خودش ممکن نیست"), "MERGE_SELF");
    }
    const source = await this.prisma.good.findUnique({
      where: { id },
      select: { id: true, nameFa: true, nameEn: true, aliases: true },
    });
    const target = await this.prisma.good.findUnique({
      where: { id: body.targetId },
      select: { id: true, nameFa: true, nameEn: true, aliases: true },
    });
    if (!source || !target) throw AppError.notFound(t(locale, "admin.goodNotFound", "کالای مرجع یافت نشد"));

    const aliases = [...new Set([...target.aliases, source.nameFa, source.nameEn ?? "", ...source.aliases])]
      .map((a) => a.trim())
      .filter((a) => a && a !== target.nameFa && a !== target.nameEn)
      .slice(0, 12);
    const nameEn = target.nameEn ?? source.nameEn;

    await this.prisma.$transaction([
      this.prisma.listing.updateMany({ where: { goodId: source.id }, data: { goodId: target.id } }),
      this.prisma.good.update({
        where: { id: target.id },
        data: {
          aliases,
          ...(nameEn ? { nameEn } : {}),
          status: "ACTIVE", // a merged good is trusted — it carries real demand
          searchText: goodSearchText({ nameFa: target.nameFa, nameEn, aliases }),
        },
      }),
      this.prisma.good.delete({ where: { id: source.id } }),
    ]);
    this.cache.invalidateTag("goods");
    return { ok: true, movedTo: target.id };
  }

  @Delete("deleteGood/:id")
  async deleteGood(@Param("id") id: string, @CurrentLocale() locale: Locale) {
    const count = await this.prisma.listing.count({ where: { goodId: id } });
    if (count > 0) {
      throw AppError.conflict(
        t(locale, "admin.goodInUse", "این کالا آگهی دارد — اول ادغامش کنید"),
        "GOOD_IN_USE"
      );
    }
    await this.prisma.good.delete({ where: { id } });
    this.cache.invalidateTag("goods");
    return { ok: true };
  }

  // ── Brand gardening ───────────────────────────────────────────────────────

  @Get("getBrands")
  async getBrands(@Query() q: AdminBrandsQueryDto): Promise<
    Page<{ id: string; name: string; source: string; _count: { listings: number } }>
  > {
    const limit = Math.min(Math.max(q.limit ?? 30, 1), 100);
    const text = q.q?.trim();
    const rows = await this.prisma.brand.findMany({
      where: {
        ...(text ? { searchText: { contains: normalizeFa(text) } } : {}),
        ...cursorBefore(decodeCursor(q.cursor)),
      },
      select: { id: true, name: true, source: true, _count: { select: { listings: true } } },
      orderBy: { id: "desc" }, // newest first — gardening candidates surface on top
      take: limit + 1,
    });
    return toPage(rows, limit);
  }

  @Post("mergeBrand/:id")
  async mergeBrand(
    @Param("id") id: string,
    @Body() body: AdminMergeDto,
    @CurrentLocale() locale: Locale
  ) {
    if (id === body.targetId) {
      throw AppError.badRequest(t(locale, "admin.mergeSelf", "ادغام برند با خودش ممکن نیست"), "MERGE_SELF");
    }
    const [source, target] = await Promise.all([
      this.prisma.brand.findUnique({ where: { id }, select: { id: true } }),
      this.prisma.brand.findUnique({ where: { id: body.targetId }, select: { id: true } }),
    ]);
    if (!source || !target) throw AppError.notFound(t(locale, "admin.brandNotFound", "برند یافت نشد"));

    await this.prisma.$transaction([
      this.prisma.listing.updateMany({ where: { brandId: source.id }, data: { brandId: target.id } }),
      this.prisma.brand.delete({ where: { id: source.id } }),
    ]);
    this.cache.invalidateTag("goods");
    return { ok: true, movedTo: target.id };
  }

  @Delete("deleteBrand/:id")
  async deleteBrand(@Param("id") id: string, @CurrentLocale() locale: Locale) {
    const count = await this.prisma.listing.count({ where: { brandId: id } });
    if (count > 0) {
      throw AppError.conflict(t(locale, "admin.brandInUse", "این برند روی آگهی استفاده شده — اول ادغامش کنید"), "BRAND_IN_USE");
    }
    await this.prisma.brand.delete({ where: { id } });
    this.cache.invalidateTag("goods");
    return { ok: true };
  }
}
