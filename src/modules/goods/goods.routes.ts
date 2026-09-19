import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { goodsService } from "./goods.service.js";

const ListQuery = Type.Object({
  q: Type.Optional(Type.String({ maxLength: 60 })),
  category: Type.Optional(Type.String({ maxLength: 40 })),
  cursor: Type.Optional(Type.String({ maxLength: 120 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export async function registerGoodsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q?: string; category?: string; cursor?: string; limit?: number } }>(
    "/",
    { schema: { querystring: ListQuery } },
    async (request, reply) => {
      const { value, hit } = await goodsService.list(request.query);
      reply.header("x-cache", hit ? "HIT" : "MISS");
      return value;
    }
  );

  app.get("/categories", async (_request, reply) => {
    const { value, hit } = await goodsService.categories();
    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  });
}
