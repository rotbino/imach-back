import { Body, Controller, Get, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { goodSearchText, normalizeFa } from "../common/catalog/catalog";
import { CacheService } from "../common/cache/cache.module";
import { CurrentLocale, CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import { t, type Locale } from "../common/i18n/i18n";
import { cursorBefore, decodeCursor, toPage, type Page } from "../common/pagination/cursor";
import { PrismaService } from "../common/prisma/prisma.module";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CreateGoodDto, GetBrandsQueryDto, GetGoodsQueryDto } from "./dto/goods.dto";

/**
 * The catalog: category tree + reference goods + brands.
 * Read-mostly and heavily re-read → every query goes through the tag-based
 * cache ("goods" tag). Cache state is exposed via `x-cache: HIT|MISS`.
 *
 * A Good is a tradeable CLASS («خرمای خازویی»), not a brand×size SKU —
 * weight/packaging live on Category.attrs, brand lives on the Listing.
 * Search is language-tolerant: normalized Persian/English/aliases in one field.
 */

const GOOD_SELECT = {
  id: true,
  nameFa: true,
  nameEn: true,
  aliases: true,
  unit: true,
  category: { select: { id: true, slug: true, nameFa: true, nameEn: true, attrs: true } },
} as const;

type GoodRow = {
  id: string;
  nameFa: string;
  nameEn: string | null;
  aliases: string[];
  unit: string;
  category: { id: string; slug: string; nameFa: string; nameEn: string; attrs: unknown };
};

export interface GoodDtoT {
  id: string;
  nameFa: string;
  nameEn: string | null;
  aliases: string[];
  unit: string;
  category: { id: string; slug: string; nameFa: string; nameEn: string; attrs: unknown };
}

interface CategoryNode {
  id: string;
  slug: string;
  nameFa: string;
  nameEn: string;
  attrs?: unknown;
  children: CategoryNode[];
}

@Controller("goods")
export class GoodsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService
  ) {}

  /** Full category tree — small (a few hundred nodes max), cached whole. */
  @Get("getCategories")
  async getCategories(@Res({ passthrough: true }) reply: FastifyReply) {
    const { value, hit } = await this.cache.wrap(
      "goods:tree",
      { ttlMs: 5 * 60_000, tags: ["goods"] },
      async (): Promise<CategoryNode[]> => {
        const rows = await this.prisma.category.findMany({
          select: { id: true, slug: true, nameFa: true, nameEn: true, attrs: true, parentId: true },
          orderBy: { id: "asc" },
        });
        const byId = new Map<string, CategoryNode>();
        for (const r of rows) {
          byId.set(r.id, {
            id: r.id,
            slug: r.slug,
            nameFa: r.nameFa,
            nameEn: r.nameEn,
            attrs: r.attrs ?? undefined,
            children: [],
          });
        }
        const roots: CategoryNode[] = [];
        for (const r of rows) {
          const node = byId.get(r.id) as CategoryNode;
          const parent = r.parentId ? byId.get(r.parentId) : undefined;
          if (parent) parent.children.push(node);
          else roots.push(node);
        }
        return roots;
      }
    );

    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  }

  @Get("getGoods")
  async getGoods(@Query() query: GetGoodsQueryDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
    const q = query.q?.trim();
    const key = `goods:list:${q ?? ""}|${query.categoryId ?? ""}|${query.cursor ?? ""}|${limit}`;

    const { value, hit } = await this.cache.wrap(
      key,
      { ttlMs: 5 * 60_000, tags: ["goods"] },
      async (): Promise<Page<GoodDtoT>> => {
        const rows: GoodRow[] = await this.prisma.good.findMany({
          where: {
            ...(q ? { searchText: { contains: normalizeFa(q) } } : {}),
            ...(q ? {} : query.categoryId ? { categoryId: query.categoryId } : {}),
            ...cursorBefore(decodeCursor(query.cursor)),
          },
          select: GOOD_SELECT,
          orderBy: { id: "desc" },
          take: limit + 1,
        });
        return toPage(rows, limit);
      }
    );

    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  }

  /** Brand suggestions — for the optional brand field of the listing form. */
  @Get("getBrands")
  async getBrands(@Query() query: GetBrandsQueryDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const q = query.q?.trim();
    const key = `goods:brands:${q ?? ""}`;
    const { value, hit } = await this.cache.wrap(
      key,
      { ttlMs: 5 * 60_000, tags: ["goods"] },
      async () => {
        const rows = await this.prisma.brand.findMany({
          where: q ? { searchText: { contains: normalizeFa(q) } } : {},
          select: { id: true, name: true },
          orderBy: { name: "asc" },
          take: 10,
        });
        return rows;
      }
    );

    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  }

  /**
   * User-created reference good — the hidden catalog-growth path.
   * When the search finds nothing, the form creates the good here and the
   * catalog crystallizes from real demand. Duplicate names (normalized)
   * return the existing row, so repeated creations converge instead of polluting.
   */
  @Post("createGood")
  @UseGuards(JwtAuthGuard)
  async createGood(
    @Body() body: CreateGoodDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const category = await this.prisma.category.findUnique({
      where: { id: body.categoryId },
      select: { id: true },
    });
    if (!category) {
      throw AppError.badRequest(
        t(locale, "catalog.categoryNotFound", "دسته‌بندی یافت نشد"),
        "CATEGORY_NOT_FOUND"
      );
    }

    const aliases = (body.aliases ?? []).map((a) => a.trim()).filter(Boolean);
    const searchText = goodSearchText({ nameFa: body.name, nameEn: body.nameEn, aliases });

    // converge duplicates: same normalized text = same reference good
    const existing = await this.prisma.good.findFirst({
      where: { searchText },
      select: GOOD_SELECT,
    });
    if (existing) return existing;

    // Creator trail + gardening queue: admin additions land trusted, ordinary
    // users land PROVISIONAL — yet every row stays usable the moment it exists.
    const isAdmin = user.role === "ADMIN";
    const created = await this.prisma.good.create({
      data: {
        categoryId: body.categoryId,
        nameFa: body.name.trim(),
        nameEn: body.nameEn?.trim() || null,
        aliases,
        searchText,
        unit: body.unit,
        source: "USER",
        status: isAdmin ? "ACTIVE" : "PROVISIONAL",
        creatorRole: isAdmin ? "ADMIN" : "USER",
        createdById: user.id,
      },
      select: GOOD_SELECT,
    });

    this.cache.invalidateTag("goods");
    return created;
  }
}
