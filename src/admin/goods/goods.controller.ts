import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { goodSearchText, normalizeFa } from "../../common/catalog/catalog";
import { CacheService } from "../../common/cache/cache.module";
import { CurrentLocale, CurrentUser, type AuthUser } from "../../common/decorators/auth.decorators";
import { AppError } from "../../common/errors/app-error";
import { t, type Locale } from "../../common/i18n/i18n";
import { cursorBefore, decodeCursor, toPage, type Page } from "../../common/pagination/cursor";
import { PrismaService } from "../../common/prisma/prisma.module";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import {
  AdminCreateGoodDto,
  AdminEditGoodDto,
  AdminGoodsQueryDto,
  AdminMergeDto,
} from "./dto";
import { AdminGuard } from "../admin.guard";

/**
 * ─── Admin · reference goods ────────────────────────────────────────────────
 * One controller per entity inside src/admin/<entity>/ — the admin surface
 * grows entity by entity, each folder moves (or splits into its own service)
 * without touching its neighbours.
 *
 * Gardening for the reference-good catalog:
 *   • list    — search/browse with live listing counts + creator trail
 *   • create  — admin-curated good, lands ACTIVE with creatorRole=ADMIN
 *   • edit    — rename / re-unit / re-home / approve (PROVISIONAL → ACTIVE)
 *   • merge   — converge duplicates: listings move, names become aliases
 *   • delete  — only empty goods; anything with listings must merge first
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
  creatorRole: true,
  createdBy: { select: { id: true, name: true } },
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
  creatorRole: string | null;
  createdBy: { id: string; name: string } | null;
  category: { id: string; slug: string; nameFa: string; nameEn: string };
  _count: { listings: number };
};

@Controller("admin/goods")
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminGoodsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService
  ) {}

  @Get("list")
  async list(@Query() q: AdminGoodsQueryDto): Promise<Page<AdminGoodRow>> {
    const limit = Math.min(Math.max(q.limit ?? 30, 1), 100);
    const text = q.q?.trim();

    // A category filter means the whole subtree: tapping «کشاورزی» in the tree
    // must surface everything beneath it, not just goods attached to the root.
    let categoryIds: string[] | undefined;
    if (q.categoryId) {
      const cats = await this.prisma.category.findMany({ select: { id: true, parentId: true } });
      const kidsOf = new Map<string, string[]>();
      for (const c of cats) {
        if (!c.parentId) continue;
        const arr = kidsOf.get(c.parentId);
        if (arr) arr.push(c.id);
        else kidsOf.set(c.parentId, [c.id]);
      }
      categoryIds = [q.categoryId];
      const stack = [q.categoryId];
      while (stack.length) {
        const cur = stack.pop() as string;
        for (const kid of kidsOf.get(cur) ?? []) {
          categoryIds.push(kid);
          stack.push(kid);
        }
      }
    }

    const rows = await this.prisma.good.findMany({
      where: {
        ...(text ? { searchText: { contains: normalizeFa(text) } } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.creator === "SYSTEM" ? { creatorRole: null } : q.creator ? { creatorRole: q.creator } : {}),
        ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
        ...cursorBefore(decodeCursor(q.cursor)),
      },
      select: ADMIN_GOOD_SELECT,
      orderBy: { id: "desc" },
      take: limit + 1,
    });
    return toPage(rows, limit);
  }

  @Post("create")
  async create(
    @Body() body: AdminCreateGoodDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const category = await this.prisma.category.findUnique({
      where: { id: body.categoryId },
      select: { id: true },
    });
    if (!category) throw AppError.badRequest(t(locale, "catalog.categoryNotFound", "دسته‌بندی یافت نشد"), "CATEGORY_NOT_FOUND");

    const aliases = (body.aliases ?? []).map((a) => a.trim()).filter(Boolean);
    const searchText = goodSearchText({ nameFa: body.nameFa, nameEn: body.nameEn, aliases });
    const dup = await this.prisma.good.findFirst({ where: { searchText }, select: { id: true } });
    if (dup) throw AppError.conflict(t(locale, "admin.goodExists", "نوع کالایی با همین نام وجود دارد"), "GOOD_EXISTS");

    const created = await this.prisma.good.create({
      data: {
        categoryId: body.categoryId,
        nameFa: body.nameFa.trim(),
        nameEn: body.nameEn?.trim() || null,
        aliases,
        searchText,
        unit: body.unit,
        status: "ACTIVE", // admin-curated = trusted from birth
        creatorRole: "ADMIN",
        createdById: user.id,
      },
      select: ADMIN_GOOD_SELECT,
    });
    this.cache.invalidateTag("goods");
    return created;
  }

  @Patch("edit/:id")
  async edit(
    @Param("id") id: string,
    @Body() body: AdminEditGoodDto,
    @CurrentLocale() locale: Locale
  ) {
    const row = await this.prisma.good.findUnique({
      where: { id },
      select: { id: true, nameFa: true, nameEn: true, aliases: true, categoryId: true },
    });
    if (!row) throw AppError.notFound(t(locale, "admin.goodNotFound", "نوع کالا یافت نشد"));

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
  @Post("merge/:id")
  async merge(
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
    if (!source || !target) throw AppError.notFound(t(locale, "admin.goodNotFound", "نوع کالا یافت نشد"));

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

  @Delete("delete/:id")
  async remove(@Param("id") id: string, @CurrentLocale() locale: Locale) {
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
}
