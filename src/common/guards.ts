import { HttpStatus } from "@nestjs/common";
import type { PrismaService } from "./prisma/prisma.module";
import type { AuthUser } from "./decorators/auth.decorators";
import { AppError } from "./errors/app-error";
import { t, type Locale } from "./i18n/i18n";

/**
 * کشِ مالکیت + ردیف کسب‌وکار برای assertBusinessOwner — ۶۰ثانیه‌ای.
 *
 * چرا امن است: مالکیت (ownerId) پس از ساخت هرگز عوض نمی‌شود؛ ردیف هم فقط
 * با editBusiness/changePhone عوض می‌شود و همان‌جا invalidateBusinessCache
 * صدا زده می‌شود. بدون این کش، «هر درخواست لیست با businessId» یک
 * رفت‌وبرگشت اضافه به Atlas داشت (از ایران ۲۰۰ms+ به ازای هر لود).
 */
const OWNER_CACHE_MS = 60_000;
const businessRowCache = new Map<string, { row: Record<string, unknown>; expiresAt: number }>();
const OWNER_CACHE_MAX = 5_000;

/** بی‌اعتبار کردن کشِ ردیف کسب‌وکار — بعد از هر ویرایش (editBusiness/changePhone/…). */
export function invalidateBusinessCache(businessId?: string): void {
  if (businessId === undefined) businessRowCache.clear();
  else businessRowCache.delete(businessId);
}

function cachedBusinessRow(businessId: string): Record<string, unknown> | undefined {
  const hit = businessRowCache.get(businessId);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    businessRowCache.delete(businessId);
    return undefined;
  }
  return hit.row;
}

function rememberBusinessRow(businessId: string, row: Record<string, unknown>): void {
  if (businessRowCache.size > OWNER_CACHE_MAX) {
    // simplest eviction — drop the oldest inserted key
    const oldest = businessRowCache.keys().next().value;
    if (oldest !== undefined) businessRowCache.delete(oldest);
  }
  businessRowCache.set(businessId, { row, expiresAt: Date.now() + OWNER_CACHE_MS });
}

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
  const cached = cachedBusinessRow(businessId);
  if (cached) {
    const ownerId = cached.ownerId as string;
    if (ownerId !== user.id && user.role !== "ADMIN") {
      throw new AppError("FORBIDDEN", t(locale, "auth.notBusinessOwner", "این کسب‌وکار متعلق به شما نیست"), HttpStatus.FORBIDDEN);
    }
    return cached as never;
  }
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw AppError.notFound("Business not found");
  rememberBusinessRow(businessId, business as unknown as Record<string, unknown>);
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
