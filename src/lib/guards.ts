import type { AuthUser } from "../plugins/auth.js";
import { prisma } from "./prisma.js";
import { errors } from "./errors.js";

/** Asserts the authenticated user owns the given business (or is ADMIN). Returns the business. */
export async function assertBusinessOwner(user: AuthUser, businessId: string) {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw errors.notFound("Business");
  if (business.ownerId !== user.id && user.role !== "ADMIN") {
    throw errors.forbidden("این کسب‌وکار متعلق به شما نیست");
  }
  return business;
}

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
  const rand = Array.from({ length: 5 }, () => SLUG_ALPHABET[Math.floor(Math.random() * SLUG_ALPHABET.length)]).join("");
  return `u-${rand}`;
}

export async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  for (let i = 0; i < 5; i++) {
    const clash = await prisma.business.findUnique({ where: { slug }, select: { id: true } });
    if (!clash) return slug;
    const rand = Array.from({ length: 4 }, () => SLUG_ALPHABET[Math.floor(Math.random() * SLUG_ALPHABET.length)]).join("");
    slug = `${base}-${rand}`;
  }
  throw errors.conflict("نمی‌توان اسلاگ یکتا ساخت، دوباره تلاش کنید", "SLUG_EXHAUSTED");
}
