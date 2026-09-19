import type { FastifyInstance } from "fastify";
import {
  QuoteRequestBody,
  SendOfferBody,
  FollowBody,
  BusinessIdQuery,
  type QuoteRequestBodyT,
  type SendOfferBodyT,
  type FollowBodyT,
} from "./market.schemas.js";
import { marketService } from "./market.service.js";

export async function registerMarketRoutes(app: FastifyInstance): Promise<void> {
  // All market routes require authentication
  app.addHook("preHandler", app.requireAuth);

  /** Buyer: run the matching engine for one of my BUY listings */
  app.post<{ Params: { id: string }; Body: QuoteRequestBodyT }>(
    "/listings/:id/quote-request",
    { schema: { body: QuoteRequestBody } },
    async (request, reply) => {
      const out = await marketService.createQuoteRequest(request.user, request.params.id, request.body?.note);
      return reply.code(201).send(out);
    }
  );

  /** Buyer: my received offers (cursor page) */
  app.get<{ Querystring: { businessId: string; cursor?: string; limit?: number } }>(
    "/offers",
    { schema: { querystring: BusinessIdQuery } },
    async (request) => marketService.myOffers(request.user, request.query.businessId, request.query.cursor, request.query.limit)
  );

  /** Seller: answer an inquiry with a price */
  app.post("/offers", { schema: { body: SendOfferBody } }, async (request) => {
    return marketService.sendOffer(request.user, request.body as SendOfferBodyT);
  });

  /** Seller: inquiries I received */
  app.get<{ Querystring: { businessId: string; cursor?: string; limit?: number } }>(
    "/inquiries",
    { schema: { querystring: BusinessIdQuery } },
    async (request) =>
      marketService.incomingInquiries(request.user, request.query.businessId, request.query.cursor, request.query.limit)
  );

  app.post<{ Params: { id: string } }>("/inquiries/:id/read", async (request) => {
    return marketService.markInquiryRead(request.user, request.params.id);
  });

  /** Follows */
  app.get("/follows", { schema: { querystring: BusinessIdQuery } }, async (request) =>
    marketService.follows(request.user, (request.query as { businessId: string }).businessId)
  );

  app.post("/follows", { schema: { body: FollowBody } }, async (request) =>
    marketService.follow(request.user, request.body as FollowBodyT)
  );

  app.delete<{ Params: { supplierId: string }; Querystring: { businessId: string } }>(
    "/follows/:supplierId",
    { schema: { querystring: BusinessIdQuery } },
    async (request) =>
      marketService.unfollow(request.user, {
        businessId: request.query.businessId,
        supplierId: request.params.supplierId,
      })
  );

  /** Live price board of followed suppliers */
  app.get("/board", { schema: { querystring: BusinessIdQuery } }, async (request, reply) => {
    const { value, hit } = await marketService.priceBoard(request.user, (request.query as { businessId: string }).businessId);
    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  });

  /** Suggested buyers for my sell catalog */
  app.get("/suggestions", { schema: { querystring: BusinessIdQuery } }, async (request, reply) => {
    const { value, hit } = await marketService.suggestions(request.user, (request.query as { businessId: string }).businessId);
    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  });
}
