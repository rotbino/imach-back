import { Controller, Get, UseGuards } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.module";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { AdminGuard } from "../admin.guard";

/**
 * ─── Admin · category tree ──────────────────────────────────────────────────
 * The full tree with goods counts: `direct` = goods attached to the node
 * itself, `total` = goods in the whole subtree. One cheap query set (all
 * categories + one groupBy), totals accumulated by a single DFS pass.
 * The panel uses it to browse basic data and jump into a filtered good list.
 */

interface AdminCategoryNode {
  id: string;
  slug: string;
  nameFa: string;
  nameEn: string;
  direct: number;
  total: number;
  children: AdminCategoryNode[];
}

@Controller("admin/categories")
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminCategoriesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("tree")
  async tree(): Promise<AdminCategoryNode[]> {
    const [cats, counts] = await Promise.all([
      this.prisma.category.findMany({
        select: { id: true, slug: true, nameFa: true, nameEn: true, parentId: true },
        orderBy: { id: "asc" },
      }),
      this.prisma.good.groupBy({ by: ["categoryId"], _count: { _all: true } }),
    ]);

    const direct = new Map<string, number>();
    for (const c of counts) direct.set(c.categoryId, c._count._all);

    const byId = new Map<string, AdminCategoryNode>();
    for (const c of cats) {
      byId.set(c.id, {
        id: c.id,
        slug: c.slug,
        nameFa: c.nameFa,
        nameEn: c.nameEn,
        direct: direct.get(c.id) ?? 0,
        total: 0,
        children: [],
      });
    }

    const roots: AdminCategoryNode[] = [];
    for (const c of cats) {
      const node = byId.get(c.id) as AdminCategoryNode;
      const parent = c.parentId ? byId.get(c.parentId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }

    const accumulate = (n: AdminCategoryNode): number => {
      n.total = n.direct + n.children.reduce((s, ch) => s + accumulate(ch), 0);
      return n.total;
    };
    roots.forEach(accumulate);

    return roots;
  }
}
