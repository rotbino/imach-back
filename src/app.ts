import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import fastifyJwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { env, isProd } from "./config/env.js";
import { authPlugin } from "./plugins/auth.js";
import { i18nPlugin } from "./plugins/i18n.js";
import { registerAuthRoutes } from "./modules/auth/auth.routes.js";
import { registerGoodsRoutes } from "./modules/goods/goods.routes.js";
import { registerBusinessesRoutes } from "./modules/businesses/businesses.routes.js";
import { registerListingsRoutes } from "./modules/listings/listings.routes.js";
import { registerMarketRoutes } from "./modules/market/market.routes.js";
import { AppError } from "./lib/errors.js";
import { cache } from "./lib/cache.js";

const API_PREFIX = "/api/v1";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: isProd ? "info" : "debug",
      redact: { paths: ["req.headers.authorization", "req.headers.cookie"], censor: "[REDACTED]" },
      ...(isProd ? {} : { transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss" } } }),
    },
    trustProxy: true, // behind Caddy / reverse proxy
    bodyLimit: 512 * 1024,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // ── Security & platform plugins ──────────────────────────────────────────
  await app.register(helmet, { contentSecurityPolicy: false });

  await app.register(cors, {
    origin: env.CORS_ORIGINS === "*" ? true : env.CORS_ORIGINS.split(",").map((o) => o.trim()),
    credentials: true,
  });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
  });

  await app.register(sensible);
  await app.register(cookie);
  await app.register(fastifyJwt, { secret: env.JWT_SECRET });
  await app.register(authPlugin);
  await app.register(i18nPlugin);

  // ── OpenAPI docs (disabled in production) ────────────────────────────────
  if (env.SWAGGER_ENABLED) {
    await app.register(swagger, {
      openapi: {
        info: { title: "iMach API", description: "B2B wholesale marketplace — iMach", version: "1.0.0" },
        servers: [{ url: API_PREFIX }],
        components: {
          securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
        },
      },
    });
    await app.register(swaggerUi, { routePrefix: "/docs" });
  }

  // ── Central error mapping ────────────────────────────────────────────────
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    // Fastify JSON-schema validation errors
    if (error.validation) {
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        message: error.message,
        fields: error.validation,
      });
    }
    // Rate limit
    if (error.statusCode === 429) {
      return reply.code(429).send({ error: "RATE_LIMITED", message: "درخواست‌های شما زیاد است، کمی بعد تلاش کنید" });
    }
    request.log.error({ err: error }, "unhandled error");
    const status = error.statusCode ?? 500;
    return reply.code(status).send({
      error: "INTERNAL_ERROR",
      message: status === 500 && isProd ? "خطای داخلی سرور" : error.message,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: "NOT_FOUND", message: `مسیر ${request.url} یافت نشد` });
  });

  // ── Routes ───────────────────────────────────────────────────────────────
  app.get(`${API_PREFIX}/health`, async () => ({
    ok: true,
    service: "imach-back",
    time: new Date().toISOString(),
    cache: cache.stats(),
  }));

  await app.register(registerAuthRoutes, { prefix: `${API_PREFIX}/auth` });
  await app.register(registerGoodsRoutes, { prefix: `${API_PREFIX}/goods` });
  await app.register(registerBusinessesRoutes, { prefix: `${API_PREFIX}/businesses` });
  await app.register(registerListingsRoutes, { prefix: `${API_PREFIX}/listings` });
  await app.register(registerMarketRoutes, { prefix: `${API_PREFIX}/market` });

  return app;
}
