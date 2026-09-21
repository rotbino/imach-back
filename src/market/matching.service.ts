import { Injectable } from "@nestjs/common";
import { matchScore } from "../common/geo/cities";
import { PrismaService } from "../common/prisma/prisma.module";

/**
 * Matching engine — a supplier match requires the SAME reference good;
 * the score adds city proximity and order-size fit. Results are persisted
 * on each Offer row so the history stays meaningful even when the
 * algorithm evolves.
 */

export interface SupplierMatch {
  sellerId: string;
  sellerName: string;
  sellerSlug: string;
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

export interface SupplierSuggestion {
  supplierId: string;
  supplierName: string;
  supplierSlug: string;
  supplierCity: string;
  supplierVerified: boolean;
  listingId: string;
  goodId: string;
  goodName: string;
  unit: string;
  price: number;
  minOrder: number;
  score: number;
}

const SELLER_SELECT = {
  id: true,
  price: true,
  minOrder: true,
  business: { select: { id: true, slug: true, name: true, city: true, isVerified: true } },
} as const;

@Injectable()
export class MatchingService {
  constructor(private readonly prisma: PrismaService) {}

  /** Suppliers selling the SAME good, ranked by score. */
  async suppliersForNeed(
    buyerBusinessId: string,
    buyerCity: string,
    goodId: string,
    volume: number,
    limit = 5
  ): Promise<SupplierMatch[]> {
    const rows = await this.prisma.listing.findMany({
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
  }

  /** Buyers looking for goods I sell, ranked by score. */
  async buyersForSeller(sellerBusinessId: string, sellerCity: string, limit = 6): Promise<BuyerMatch[]> {
    const mySellListings = await this.prisma.listing.findMany({
      where: { businessId: sellerBusinessId, mode: { in: ["SELL", "BOTH"] }, price: { not: null } },
      select: { goodId: true, minOrder: true },
    });
    if (mySellListings.length === 0) return [];

    const goodIds = [...new Set(mySellListings.map((l) => l.goodId))];
    const minOrderByGood = new Map(mySellListings.map((l) => [l.goodId, l.minOrder ?? 0]));

    const buyRows = await this.prisma.listing.findMany({
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
        business: { select: { id: true, slug: true, name: true, city: true, isVerified: true } },
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
          buyerCity: b.city,
          buyerVerified: b.isVerified,
          buyListingId: row.id,
          goodId: row.good.id,
          goodName: row.good.name,
          unit: row.good.unit,
          volume,
          frequency: row.frequency as string,
          score: matchScore(b.city, sellerCity, volume, minOrderByGood.get(row.good.id) ?? 0),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Suppliers selling goods I need, ranked by score — the buy-side engine. */
  async suppliersForBuyer(
    buyerBusinessId: string,
    buyerCity: string,
    limit = 6
  ): Promise<SupplierSuggestion[]> {
    const myBuyListings = await this.prisma.listing.findMany({
      where: {
        businessId: buyerBusinessId,
        mode: { in: ["BUY", "BOTH"] },
        volume: { not: null },
      },
      select: { goodId: true, volume: true },
    });
    if (myBuyListings.length === 0) return [];

    const goodIds = [...new Set(myBuyListings.map((l) => l.goodId))];
    const volumeByGood = new Map(
      myBuyListings.map((l) => [l.goodId, l.volume as number])
    );

    const sellRows = await this.prisma.listing.findMany({
      where: {
        goodId: { in: goodIds },
        businessId: { not: buyerBusinessId },
        mode: { in: ["SELL", "BOTH"] },
        price: { not: null },
      },
      select: {
        id: true,
        price: true,
        minOrder: true,
        good: { select: { id: true, name: true, unit: true } },
        business: { select: { id: true, slug: true, name: true, city: true, isVerified: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 120,
    });

    return sellRows
      .map((row) => {
        const b = row.business;
        return {
          supplierId: b.id,
          supplierName: b.name,
          supplierSlug: b.slug,
          supplierCity: b.city,
          supplierVerified: b.isVerified,
          listingId: row.id,
          goodId: row.good.id,
          goodName: row.good.name,
          unit: row.good.unit,
          price: row.price as number,
          minOrder: row.minOrder ?? 0,
          score: matchScore(
            buyerCity,
            b.city,
            volumeByGood.get(row.good.id) ?? 0,
            row.minOrder ?? 0
          ),
        };
      })
      .sort((a, b) => b.score - a.score || a.price - b.price)
      .slice(0, limit);
  }
}
