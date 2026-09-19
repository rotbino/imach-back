import { prisma } from "../../lib/prisma.js";
import { cache, TTL } from "../../lib/cache.js";
import { errors } from "../../lib/errors.js";
import { assertBusinessOwner, makeSlug, uniqueSlug } from "../../lib/guards.js";
import type { AuthUser } from "../../plugins/auth.js";

const LISTING_SELECT = {
  id: true,
  mode: true,
  price: true,
  stock: true,
  minOrder: true,
  volume: true,
  frequency: true,
  good: { select: { id: true, name: true, category: true, unit: true } },
} as const;

function invalidateBusiness(businessId: string, slug?: string): void {
  cache.invalidateTag(`business:${businessId}`);
  if (slug) cache.invalidateTag(`business:slug:${slug}`);
  cache.invalidateTag(`market:board:${businessId}`);
  cache.invalidateTag(`market:sugg:${businessId}`);
}

export const businessesService = {
  async mine(user: AuthUser) {
    return prisma.business.findMany({
      where: { ownerId: user.id },
      select: {
        id: true,
        slug: true,
        name: true,
        role: true,
        city: true,
        isVerified: true,
        _count: { select: { listings: true } },
      },
      orderBy: { createdAt: "asc" },
    });
  },

  async create(user: AuthUser, body: { name: string; role: string; city: string; phone?: string }) {
    const slug = await uniqueSlug(makeSlug(body.name));
    const business = await prisma.business.create({
      data: {
        slug,
        name: body.name.trim(),
        role: body.role as never,
        city: body.city.trim(),
        phone: body.phone?.trim() || null,
        ownerId: user.id,
      },
    });
    invalidateBusiness(business.id, business.slug);
    return business;
  },

  /** Public profile by slug — heavily re-read (every arm visit) → cached. */
  async profileBySlug(slug: string) {
    const { value, hit } = await cache.wrap(
      `business:profile:${slug}`,
      { ttlMs: TTL.MINUTE, tags: [`business:slug:${slug}`] },
      async () => {
        const business = await prisma.business.findUnique({
          where: { slug },
          select: {
            id: true,
            slug: true,
            name: true,
            role: true,
            city: true,
            phone: true,
            isVerified: true,
            isDemo: true,
            listings: {
              select: LISTING_SELECT,
              orderBy: { updatedAt: "desc" },
            },
          },
        });
        return business;
      }
    );
    if (!value) throw errors.notFound("Business");
    return { value, hit };
  },

  async update(user: AuthUser, businessId: string, body: { name?: string; role?: string; city?: string; phone?: string }) {
    const business = await assertBusinessOwner(user, businessId);
    const updated = await prisma.business.update({
      where: { id: business.id },
      data: {
        ...(body.name ? { name: body.name.trim() } : {}),
        ...(body.role ? { role: body.role as never } : {}),
        ...(body.city ? { city: body.city.trim() } : {}),
        ...(body.phone !== undefined ? { phone: body.phone?.trim() || null } : {}),
      },
    });
    invalidateBusiness(updated.id, business.slug); // old slug tag + new data
    return updated;
  },
};
