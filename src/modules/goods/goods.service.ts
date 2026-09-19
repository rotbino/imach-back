import { prisma } from "../../lib/prisma.js";
import { cache, TTL } from "../../lib/cache.js";
import { decodeCursor, cursorBefore, toPage, type Page } from "../../lib/cursor.js";

export interface GoodDtoT {
  id: string;
  name: string;
  category: string;
  unit: string;
}

export interface GoodListQuery {
  q?: string;
  category?: string;
  cursor?: string;
  limit?: number;
}

export const goodsService = {
  /** Cached, cursor-paginated reference catalog. Tag "goods" → invalidated on seed/admin changes. */
  async list(query: GoodListQuery): Promise<{ value: Page<GoodDtoT>; hit: boolean }> {
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
    const key = `goods:list:${query.q ?? ""}|${query.category ?? ""}|${query.cursor ?? ""}|${limit}`;

    return cache.wrap(key, { ttlMs: TTL.FIVE_MIN, tags: ["goods"] }, async () => {
      const rows = await prisma.good.findMany({
        where: {
          ...(query.category ? { category: query.category } : {}),
          ...(query.q ? { name: { contains: query.q } } : {}),
          ...cursorBefore(decodeCursor(query.cursor)),
        },
        select: { id: true, name: true, category: true, unit: true },
        orderBy: { id: "desc" },
        take: limit + 1,
      });
      return toPage(rows, limit);
    });
  },

  async categories(): Promise<{ value: string[]; hit: boolean }> {
    return cache.wrap("goods:categories", { ttlMs: TTL.FIVE_MIN, tags: ["goods"] }, async () => {
      const rows = await prisma.good.findMany({
        select: { category: true },
        distinct: ["category"],
        orderBy: { category: "asc" },
      });
      return rows.map((r) => r.category);
    });
  },
};
