import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { DEFAULT_LOCALE, type Locale } from "../i18n/i18n";

/** Minimal JWT claims embedded in every access token. */
export interface AuthUser {
  id: string;
  phone: string;
  role: "MEMBER" | "ADMIN";
}

/** Resolved AuthUser for the current request (set by JwtAuthGuard). */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest<FastifyRequest>().user as AuthUser;
});

/** Resolved content locale of the current request (Accept-Language → default). */
export const CurrentLocale = createParamDecorator((_data: unknown, ctx: ExecutionContext): Locale => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  return ((req as FastifyRequest & { locale?: Locale }).locale ?? DEFAULT_LOCALE) as Locale;
});

/** Slug generator + ownership guard helpers. */
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Deterministic-friendly slug: latinize when possible, otherwise fall back to a short id. */
export function makeSlug(name: string): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\u0600-\u06FF-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (/^[a-z0-9-]+$/.test(clean) && clean.length >= 3 && clean.length <= 24) return clean;
  const rand = Array.from({ length: 5 }, () =>
    SLUG_ALPHABET[Math.floor(Math.random() * SLUG_ALPHABET.length)]
  ).join("");
  return `u-${rand}`;
}

/** Fastify request augmentations — claims from JwtAuthGuard + i18n locale. */
declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
    locale?: Locale;
  }
}
