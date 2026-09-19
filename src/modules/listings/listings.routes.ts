import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { UpsertListingBody, type UpsertListingBodyT } from "./listings.schemas.js";
import { listingsService } from "./listings.service.js";

const MineQuery = Type.Object({
  businessId: Type.String({ minLength: 1 }),
});

export async function registerListingsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { businessId: string } }>(
    "/mine",
    {
      preHandler: [app.requireAuth],
      schema: { querystring: MineQuery },
    },
    async (request) => listingsService.mine(request.user, request.query.businessId)
  );

  app.put(
    "/",
    { preHandler: [app.requireAuth], schema: { body: UpsertListingBody } },
    async (request) => listingsService.upsert(request.user, request.body as UpsertListingBodyT)
  );

  app.delete<{ Params: { id: string } }>(
    "/:id",
    { preHandler: [app.requireAuth] },
    async (request) => listingsService.remove(request.user, request.params.id)
  );
}
