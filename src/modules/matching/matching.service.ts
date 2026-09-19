import { prisma } from "../../lib/prisma.js";
import { matchScore } from "../../lib/cities.js";

/**
 * Matching engine — ports the scoring formula validated in the prototype:
 * a supplier match requires the SAME reference good; score adds city
 * proximity and order-size fit. Results are persisted on each Offer row so
 * the history stays meaningful even when the algorithm evolves.
 */

export interface SupplierMatch {
  sellerId: string;
  sellerName: string;
  sellerSlug: string;
  sellerRole: string;
  sellerCity: string;
  sellerVerified: boolean;
  listingId: string;
  price: number;
  minOrder: number;
  score: number;
  isSpecial: boolean;
}

export interface BuyerMatch {
  buyerId: string;
  buyerName: string;
  buyerSlug: string;
  buyerRole: string;
  buyerCity: string;
  buyerVerified: boolean;
  buyListingId: string;
  goodId: string;
  goodName: string;
  unit: string;
  volume: number;
  frequency: string;
  score: number;
}

const SELLER_SELECT = {
  id: true,
  price: true,
  minOrder: true,
  business: { select: { id: true, slug: true, name: true, role: true, city: true, isVerified: true } },
} as const;

export const matchingService = {
  /** Suppliers selling the SAME good, ranked by score. */
  async suppliersForNeed(
    buyerBusinessId: string,
    buyerCity: string,
    goodId: string,
    volume: number,
    limit = 5
  ): Promise<SupplierMatch[]> {
    const rows = await prisma.listing.findMany({
      where: {
        goodId,
        businessId: { not: buyerBusinessId },
        mode: { in: ["SELL", "BOTH"] },
        price: { not: null },
      },
      select: SELLER_SELECT,
      orderBy: { updatedAt: "desc" },
      take: 50, // bounded scan; final ranking happens in memory
    });

    return rows
      .map((row) => {
        const b = row.business;
        const price = row.price as number;
        const minOrder = row.minOrder ?? 0;
        const score = matchScore(buyerCity, b.city, volume, minOrder);
        return {
          sellerId: b.id,
          sellerName: b.name,
          sellerSlug: b.slug,
          sellerRole: b.role as string,
          sellerCity: b.city,
          sellerVerified: b.isVerified,
          listingId: row.id,
          price,
          minOrder,
          score,
          isSpecial: score >= 90,
        };
      })
      .sort((a, b) => b.score - a.score || a.price - b.price)
      .slice(0, limit);
  },

  /** Buyers looking for goods I sell, ranked by score. */
  async buyersForSeller(sellerBusinessId: string, sellerCity: string, limit = 6): Promise<BuyerMatch[]> {
    const mySellListings = await prisma.listing.findMany({
      where: { businessId: sellerBusinessId, mode: { in: ["SELL", "BOTH"] }, price: { not: null } },
      select: { goodId: true, minOrder: true },
    });
    if (mySellListings.length === 0) return [];

    const goodIds = [...new Set(mySellListings.map((l) => l.goodId))];
    const minOrderByGood = new Map(mySellListings.map((l) => [l.goodId, l.minOrder ?? 0]));

    const buyRows = await prisma.listing.findMany({
      where: {
        goodId: { in: goodIds },
        businessId: { not: sellerBusinessId },
        mode: { in: ["BUY", "BOTH"] },
        volume: { not: null },
      },
      select: {
        id: true,
        volume: true,
        frequency: true,
        good: { select: { id: true, name: true, unit: true } },
        business: { select: { id: true, slug: true, name: true, role: true, city: true, isVerified: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 80,
    });

    return buyRows
      .map((row) => {
        const b = row.business;
        const volume = row.volume as number;
        return {
          buyerId: b.id,
          buyerName: b.name,
          buyerSlug: b.slug,
          buyerRole: b.role as string,
          buyerCity: b.city,
          buyerVerified: b.isVerified,
          buyListingId: row.id,
          goodId: row.good.id,
          goodName: row.good.name,
          unit: row.good.unit as string,
          volume,
          frequency: row.frequency as string,
          score: matchScore(b.city, sellerCity, volume, minOrderByGood.get(row.good.id) ?? 0),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  },
};
