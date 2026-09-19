import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { resolveLocale, t, type Locale } from "../lib/i18n.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Content locale resolved for this request (Accept-Language → default). */
    locale: Locale;
    /** Translate a message key for this request's locale. */
    t: (key: string, fallback?: string) => string;
  }
}

/**
 * i18n plugin — decorates every request with the resolved locale and a
 * request-scoped translator. Services use `request.t("module.key")` so
 * user-facing messages can be localized later without touching routes.
 */
async function i18nDecorator(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request: FastifyRequest) => {
    const locale = resolveLocale(request.headers["accept-language"]);
    request.locale = locale;
    request.t = (key: string, fallback?: string) => t(locale, key, fallback);
  });
}

/** fastify-plugin keeps decorators on the parent scope for route modules. */
export const i18nPlugin = fp(i18nDecorator, { name: "i18n" });
