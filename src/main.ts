import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "@fastify/helmet";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import type { FastifyRequest } from "fastify";
import { AppModule } from "./app.module";
import { env, isProd, storage } from "./common/config/env";
import { DEFAULT_LOCALE, resolveLocale, type Locale } from "./common/i18n/i18n";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";

const API_PREFIX = "api/v1";

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    trustProxy: true, // behind Caddy / reverse proxy
    // multipart uploads (file service) need headroom above MAX_FILE_SIZE
    bodyLimit: Math.max(512 * 1024, storage.MAX_FILE_SIZE + 1024 * 1024),
    // request-level logging in dev only (tokens/cookies never logged)
    logger: isProd
      ? false
      : { level: "warn", redact: { paths: ["req.headers.authorization", "req.headers.cookie"], censor: "[REDACTED]" } },
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { logger: isProd ? ["error", "warn"] : undefined });

  // ── Security & platform ────────────────────────────────────────────────────
  // CORP = cross-origin: عکس‌های عمومی (درایور local و همین‌طور آروان) از
  // دامنه‌ی دیگری از صفحه سرو می‌شوند؛ same-origin پیش‌فرضِ helmet آن‌ها را
  // در مرورگر بلاک می‌کند (عکس آپلودشده در کارت کالا «شکسته» دیده می‌شد)
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: { fileSize: storage.MAX_FILE_SIZE, files: 1, fields: 10 },
  });

  // Local storage driver serves ./uploads directly (arvan driver ignores this)
  if (storage.DRIVER === "local") {
    await app.register(fastifyStatic, { root: path.resolve(storage.UPLOAD_PATH), prefix: "/uploads/" });
  }

  app.enableCors({
    origin: env.CORS_ORIGINS === "*" ? true : env.CORS_ORIGINS.split(",").map((o) => o.trim()),
    credentials: true,
  });

  // ── i18n: resolve the request locale once, on the raw Fastify layer ────────
  // Services translate user-facing messages with t(locale, key, fallback).
  const instance = adapter.getInstance();
  instance.decorateRequest("locale", DEFAULT_LOCALE);
  instance.addHook("onRequest", (request, _reply, done) => {
    (request as FastifyRequest & { locale: Locale }).locale = resolveLocale(
      request.headers["accept-language"]
    );
    done();
  });

  // ── Validation & error shape ───────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown properties
      transform: true, // DTO @Type() conversions (query numbers, …)
    })
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();

  // ── OpenAPI docs (disabled in production) ──────────────────────────────────
  if (env.SWAGGER_ENABLED) {
    const config = new DocumentBuilder()
      .setTitle("iMach API")
      .setDescription("B2B wholesale marketplace — iMach")
      .setVersion("2.0.0")
      .addBearerAuth()
      .build();
    SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, config));
  }

  await app.listen({ port: env.PORT, host: env.HOST });
  if (!isProd) console.log(`iMach API ready on :${env.PORT}`);
}

void bootstrap().catch((err) => {
  console.error("Fatal bootstrap error:", err);
  process.exit(1);
});
