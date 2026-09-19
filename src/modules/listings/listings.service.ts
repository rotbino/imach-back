import { prisma } from "../../lib/prisma.js";
import { cache } from "../../lib/cache.js";
import { errors } from "../../lib/errors.js";
import { assertBusinessOwner } from "../../lib/guards.js";
import type { AuthUser } from "../../plugins/auth.js";
import type { UpsertListingBodyT } from "./listings.schemas.js";

function invalidateFor(businessId: string): void {
  cache.invalidateTag(`business:${businessId}`);
  cache.invalidateTag(`market:board:${businessId}`);
  cache.invalidateTag(`market:sugg:${businessId}`);
  cache.invalidateTag("matching");
}

export const listingsService = {
  async mine(user: AuthUser, businessId: string) {
    await assertBusinessOwner(user, businessId);
    return prisma.listing.findMany({
      where: { businessId },
      select: {
        id: true,
        mode: true,
        price: true,
        stock: true,
        minOrder: true,
        volume: true,
        frequency: true,
        updatedAt: true,
        good: { select: { id: true, name: true, category: true, unit: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
  },

  /**
   * Upsert one listing per (business, good). Price changes are recorded in
   * PriceLog so the live board can show trends without extra bookkeeping.
   */
  async upsert(user: AuthUser, body: UpsertListingBodyT) {
    const business = await assertBusinessOwner(user, body.businessId);

    const good = await prisma.good.findUnique({ where: { id: body.goodId }, select: { id: true } });
    if (!good) throw errors.badRequest("کالای مرجع یافت نشد", "GOOD_NOT_FOUND");

    // Spec consistency: SELL/BOTH require sell spec, BUY/BOTH require buy spec
    if (body.mode !== "BUY" && !body.sell) {
      throw errors.badRequest("برای فروش، مشخصات قیمت و موجودی الزامی است", "SELL_SPEC_REQUIRED");
    }
    if (body.mode !== "SELL" && !body.buy) {
      throw errors.badRequest("برای خرید، حجم و تناوب الزامی است", "BUY_SPEC_REQUIRED");
    }

    const data = {
      mode: body.mode as never,
      ...(body.mode !== "BUY" && body.sell
        ? { price: body.sell.price, stock: body.sell.stock, minOrder: body.sell.minOrder }
        : { price: null, stock: null, minOrder: null }),
      ...(body.mode !== "SELL" && body.buy
        ? { volume: body.buy.volume, frequency: body.buy.frequency as never }
        : { volume: null, frequency: null }),
    };

    const existing = await prisma.listing.findUnique({
      where: { businessId_goodId: { businessId: business.id, goodId: body.goodId } },
      select: { id: true, price: true },
    });

    const listing = await prisma.listing.upsert({
      where: { businessId_goodId: { businessId: business.id, goodId: body.goodId } },
      create: { businessId: business.id, goodId: body.goodId, ...data },
      update: data,
      select: { id: true, mode: true, price: true, stock: true, minOrder: true, volume: true, frequency: true, good: { select: { id: true, name: true, category: true, unit: true } } },
    });

    if (existing && existing.price !== null && listing.price !== null && existing.price !== listing.price) {
      await prisma.priceLog.create({
        data: { listingId: listing.id, oldPrice: existing.price, newPrice: listing.price },
      });
    }

    invalidateFor(business.id);
    return listing;
  },

  async remove(user: AuthUser, listingId: string) {
    const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, businessId: true } });
    if (!listing) throw errors.notFound("Listing");
    await assertBusinessOwner(user, listing.businessId);
    await prisma.listing.delete({ where: { id: listing.id } });
    invalidateFor(listing.businessId);
    return { ok: true };
  },

  /** Public: sell-side listings of one business with latest price log (live board rows). */
  async sellListingsOf(supplierIds: readonly string[]) {
    return prisma.listing.findMany({
      where: { businessId: { in: [...supplierIds] }, mode: { in: ["SELL", "BOTH"] }, price: { not: null } },
      select: {
        id: true,
        price: true,
        stock: true,
        minOrder: true,
        updatedAt: true,
        good: { select: { id: true, name: true, category: true, unit: true } },
        business: { select: { id: true, slug: true, name: true, city: true, role: true, isVerified: true } },
        priceLogs: { orderBy: { createdAt: "desc" as const }, take: 1, select: { oldPrice: true, newPrice: true, createdAt: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
  },
};
