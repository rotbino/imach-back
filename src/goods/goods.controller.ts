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
  /** default wholesale unit of the leaf — the form prefills it for new goods */
  unit?: string;
  isActive: boolean;
  children: CategoryNode[];
}

/** Hidden subtree (e.g. services) — pruned wholesale, node and descendants. */
function pruneHidden(roots: CategoryNode[]): CategoryNode[] {
  const keep = (n: CategoryNode): CategoryNode | null =>
    n.isActive
      ? { ...n, children: n.children.map(keep).filter(Boolean) as CategoryNode[] }
      : null;
  return roots.map(keep).filter(Boolean) as CategoryNode[];
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
          select: { id: true, slug: true, nameFa: true, nameEn: true, attrs: true, unit: true, isActive: true, parentId: true },
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
            unit: r.unit ?? undefined,
            isActive: r.isActive,
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
        return pruneHidden(roots);
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
            category: { isActive: true },
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
   * JSON مرجع کاتالوگ برای پرامپت هوش مصنوعی — همه‌ی گودها + برندها + دسته‌ها
   * در یک JSON فشرده. کاربر این را به AI می‌دهد تا اکسل خروجی دقیقاً مطابق با
   * گودهای موجود باشد (خواسته‌ی کاربر: «برندها و گروههای کالا و لیست گود رو هم
   * به هوش مصنوعی بده»).
   *
   * عمومی است (بدون auth) تا کاربر بتواند آن را کپی کند و به هر AI بدهد.
   * cache پنج‌دقیقه‌ای چون کاتالوگ زیاد تغییر نمی‌کند.
   */
  @Get("getCatalogReference")
  async getCatalogReference(@Res({ passthrough: true }) reply: FastifyReply) {
    const { value, hit } = await this.cache.wrap(
      "goods:catalog-reference",
      { ttlMs: 5 * 60_000, tags: ["goods"] },
      async () => {
        const [goods, brands, categories] = await Promise.all([
          this.prisma.good.findMany({
            where: { status: "ACTIVE" },
            select: {
              id: true,
              nameFa: true,
              nameEn: true,
              aliases: true,
              unit: true,
              categoryId: true,
            },
            orderBy: { nameFa: "asc" },
          }),
          this.prisma.brand.findMany({
            where: { status: "ACTIVE" },
            select: { id: true, name: true },
            orderBy: { name: "asc" },
          }),
          this.prisma.category.findMany({
            where: { isActive: true },
            select: { id: true, slug: true, nameFa: true, nameEn: true, parentId: true },
          }),
        ]);

        // ساخت درخت دسته‌ها (flat → tree) برای خوانایی بهتر
        const catById = new Map(categories.map((c) => [c.id, { ...c, children: [] as any[], goods: [] as any[] }]));
        const catRoots: any[] = [];
        for (const c of categories) {
          const node = catById.get(c.id)!;
          if (c.parentId && catById.has(c.parentId)) {
            catById.get(c.parentId)!.children.push(node);
          } else {
            catRoots.push(node);
          }
        }

        // گودها را به دسته‌شان وصل کن
        const goodsByCategory = new Map<string, any[]>();
        for (const g of goods) {
          const arr = goodsByCategory.get(g.categoryId) ?? [];
          arr.push({ name: g.nameFa, aliases: g.aliases, unit: g.unit });
          goodsByCategory.set(g.categoryId, arr);
        }
        for (const cat of catById.values()) {
          cat.goods = goodsByCategory.get(cat.id) ?? [];
        }

        return {
          categories: catRoots.map((c) => ({
            name: c.nameFa,
            slug: c.slug,
            goods: c.goods,
            children: c.children,
          })),
          brands: brands.map((b) => b.name),
          totalGoods: goods.length,
          totalBrands: brands.length,
        };
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
   *
   * categoryId اختیاری: فرم سرچ‌محور دسته نمی‌پرسد — کالای بدون دسته، خودکار
   * در سبد «سایر › جدید» (واحد عدد) پارک می‌شود تا ادمین بعداً باغبانی کند.
   */
  @Post("createGood")
  @UseGuards(JwtAuthGuard)
  async createGood(
    @Body() body: CreateGoodDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    let categoryId = body.categoryId;

    if (!categoryId) {
      // سبد موقت انواع کاربری: ریشه‌ی «سایر» + برگ «جدید» — find-or-create idempotent
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

    const category = await this.prisma.category.findUnique({
      where: { id: categoryId },
      select: { id: true, unit: true, isActive: true, _count: { select: { children: true } } },
    });
    if (!category || !category.isActive) {
      throw AppError.badRequest(
        t(locale, "catalog.categoryNotFound", "دسته‌بندی یافت نشد"),
        "CATEGORY_NOT_FOUND"
      );
    }
    if (category._count.children > 0) {
      // goods are catalog leaves — a mid-level node is a misclick, send the
      // user one level deeper instead of silently parking the good too high
      throw AppError.badRequest(
        t(locale, "catalog.categoryNotLeaf", "یک زیرشاخه دقیق‌تر انتخاب کنید"),
        "CATEGORY_NOT_LEAF"
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
        categoryId,
        nameFa: body.name.trim(),
        nameEn: body.nameEn?.trim() || null,
        aliases,
        searchText,
        // the leaf's unit IS the unit — the form prefills it, the backend
        // trusts the leaf over the client so every good under a leaf agrees
        unit: category.unit ?? body.unit ?? "PIECE",
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
