import { Controller, Get, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CacheService } from "../common/cache/cache.module";
import { cursorBefore, decodeCursor, toPage, type Page } from "../common/pagination/cursor";
import { PrismaService } from "../common/prisma/prisma.module";
import { GetGoodsQueryDto } from "./dto/goods.dto";

const GOOD_SELECT = { id: true, name: true, category: true, unit: true } as const;

export type GoodDtoT = { id: string; name: string; category: string; unit: string };

/**
 * Reference catalog — read-mostly and heavily re-read, so every query
 * goes through the tag-based cache ("goods" tag). Cache state is exposed
 * via the `x-cache: HIT|MISS` response header.
 */
@Controller("goods")
export class GoodsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService
  ) {}

  @Get("getGoods")
  async getGoods(@Query() query: GetGoodsQueryDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
    const key = `goods:list:${query.q ?? ""}|${query.category ?? ""}|${query.cursor ?? ""}|${limit}`;

    const { value, hit } = await this.cache.wrap(
      key,
      { ttlMs: 5 * 60_000, tags: ["goods"] },
      async (): Promise<Page<GoodDtoT>> => {
        const rows = await this.prisma.good.findMany({
          where: {
            ...(query.category ? { category: query.category } : {}),
            ...(query.q ? { name: { contains: query.q } } : {}),
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

  @Get("getCategories")
  async getCategories(@Res({ passthrough: true }) reply: FastifyReply) {
    const { value, hit } = await this.cache.wrap(
      "goods:categories",
      { ttlMs: 5 * 60_000, tags: ["goods"] },
      async () => {
        const rows = await this.prisma.good.findMany({
          select: { category: true },
          distinct: ["category"],
          orderBy: { category: "asc" },
        });
        return rows.map((r) => r.category);
      }
    );

    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  }
}
