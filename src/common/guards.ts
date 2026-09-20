import { HttpStatus } from "@nestjs/common";
import type { PrismaService } from "./prisma/prisma.module";
import type { AuthUser } from "./decorators/auth.decorators";
import { AppError } from "./errors/app-error";
import { t, type Locale } from "./i18n/i18n";

/**
 * Asserts the authenticated user owns the given business (or is ADMIN).
 * Returns the business row. Used by every business-scoped endpoint.
 */
export async function assertBusinessOwner(
  prisma: PrismaService,
  user: AuthUser,
  businessId: string,
  locale: Locale
) {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw AppError.notFound("Business not found");
  if (business.ownerId !== user.id && user.role !== "ADMIN") {
    throw new AppError("FORBIDDEN", t(locale, "auth.notBusinessOwner", "این کسب‌وکار متعلق به شما نیست"), HttpStatus.FORBIDDEN);
  }
  return business;
}

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

const randomSuffix = (len: number): string =>
  Array.from({ length: len }, () => SLUG_ALPHABET[Math.floor(Math.random() * SLUG_ALPHABET.length)]).join("");

/** Tries a few slug variants before giving up (5 attempts, then SLUG_EXHAUSTED). */
export async function uniqueSlug(prisma: PrismaService, base: string, locale: Locale): Promise<string> {
  let slug = base;
  for (let i = 0; i < 5; i++) {
    const clash = await prisma.business.findUnique({ where: { slug }, select: { id: true } });
    if (!clash) return slug;
    slug = `${base}-${randomSuffix(4)}`;
  }
  throw AppError.conflict(t(locale, "auth.slugExhausted", "نمی‌توان اسلاگ یکتا ساخت، دوباره تلاش کنید"), "SLUG_EXHAUSTED");
}
