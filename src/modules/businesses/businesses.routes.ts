import type { FastifyInstance } from "fastify";
import { CreateBusinessBody, UpdateBusinessBody, type CreateBusinessBodyT, type UpdateBusinessBodyT } from "./businesses.schemas.js";
import { businessesService } from "./businesses.service.js";

export async function registerBusinessesRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/mine",
    { preHandler: [app.requireAuth] },
    async (request) => businessesService.mine(request.user)
  );

  app.post(
    "/",
    { preHandler: [app.requireAuth], schema: { body: CreateBusinessBody } },
    async (request, reply) => {
      const business = await businessesService.create(request.user, request.body as CreateBusinessBodyT);
      return reply.code(201).send(business);
    }
  );

  app.get<{ Params: { slug: string } }>("/:slug", async (request, reply) => {
    const { value, hit } = await businessesService.profileBySlug(request.params.slug);
    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  });

  app.patch<{ Params: { id: string }; Body: UpdateBusinessBodyT }>(
    "/:id",
    { preHandler: [app.requireAuth], schema: { body: UpdateBusinessBody } },
    async (request) => businessesService.update(request.user, request.params.id, request.body)
  );
}
