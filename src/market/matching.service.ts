import { Injectable } from "@nestjs/common";
import { matchScore, proximity } from "../common/geo/cities";
import { PrismaService } from "../common/prisma/prisma.module";

/**
 * Matching engine — a match requires the SAME reference good;
 * the score adds order-size fit, price rank, proximity (city >
 * province) and recency. Results are persisted on each Offer row
 * so the history stays meaningful even when the algorithm evolves.
 */

export interface SupplierMatch {
  sellerId: string;
  sellerName: string;
  sellerSlug: string;
  sellerCity: string;
  sellerVerified: boolean;
  listingId: string;
  priceMinor: number;
  currency: string | null;
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
  priceMinor: number;
  currency: string | null;
  minOrder: number;
  score: number;
}

/** A ranked listing row for the personalized market lists. */
export interface RankedRow {
  id: string;
  mode: string;
  priceMinor: number | null;
  currency: string | null;
  stock: number | null;
  minOrder: number | null;
  volume: number | null;
  frequency: string | null;
  updatedAt: Date;
  good: { id: string; nameFa: string; nameEn: string | null; unit: string; category: { nameFa: string; nameEn: string } };
  business: {
    id: string;
    slug: string;
    name: string;
    city: string;
    isVerified: boolean;
    activityType: string | null;
    _count: { followers: number };
  };
  score: number;
}

const SELLER_SELECT = {
  id: true,
  priceMinor: true,
  currency: true,
  minOrder: true,
  business: { select: { id: true, slug: true, name: true, city: true, isVerified: true } },
} as const;

const RANK_SELECT = {
  id: true,
  mode: true,
  priceMinor: true,
  currency: true,
  stock: true,
  minOrder: true,
  volume: true,
  frequency: true,
  updatedAt: true,
  good: {
    select: {
      id: true,
      nameFa: true,
      nameEn: true,
      unit: true,
      category: { select: { nameFa: true, nameEn: true } },
    },
  },
  business: {
    select: {
      id: true,
      slug: true,
      name: true,
      city: true,
      isVerified: true,
      activityType: true,
      _count: { select: { followers: true } },
    },
  },
} as const;

const hoursSince = (d: Date): number => (Date.now() - d.getTime()) / 3_600_000;

/** Freshness points: 0–6 — new items must be seen. */
function recencyScore(d: Date): number {
  const h = hoursSince(d);
  if (h <= 48) return 6;
  if (h <= 24 * 7) return 3;
  return 0;
}

/**
 * Volume fit of `volume` against a seller's working band [minOrder..stock].
 * 0–30 — the dominant factor of the buy-requests list.
 */
function volumeFit(minOrder: number, stock: number, volume: number): number {
  if (minOrder > 0 && volume < minOrder) return 4; // smaller than the seller's minimum
  if (stock > 0 && volume > stock * 2) return 2; // far beyond the seller's capacity
  return 30; // inside the working band
}

/**
 * Capacity fit of a supplier band [minOrder..stock] for `volume`.
 * 0–28 — the dominant factor of the sell-offers list.
 */
function capacityFit(minOrder: number, stock: number, volume: number): number {
  if (minOrder > 0 && volume < minOrder) return 4; // seller won't sell that small
  if (stock > 0 && volume > stock * 2) return 2; // supplier can't cover the need
  return 28; // band covers the need
}

/** Proximity points for the ranked lists. */
function proxPoints(a: string, b: string, same: number, near: number, far: number): number {
  const p = proximity(a, b);
  return p === "same" ? same : p === "near" ? near : far;
}

/** Price-rank points (0–18) inside a same-good candidate group — cheaper is better. */
function priceRanks(rows: { id: string; priceMinor: number | null; goodId: string }[]): Map<string, number> {
  const pts = new Map<string, number>();
  const byGood = new Map<string, { id: string; priceMinor: number }[]>();
  for (const r of rows) {
    if (r.priceMinor === null) continue;
    const arr = byGood.get(r.goodId) ?? [];
    arr.push({ id: r.id, priceMinor: r.priceMinor });
    byGood.set(r.goodId, arr);
  }
  for (const group of byGood.values()) {
    group.sort((a, b) => a.priceMinor - b.priceMinor);
    const n = group.length;
    group.forEach((g, i) => pts.set(g.id, n === 1 ? 9 : Math.round(18 * (1 - i / (n - 1)))));
  }
  return pts;
}

@Injectable()
export class MatchingService {
  constructor(private readonly prisma: PrismaService) {}

  /** Suppliers selling the SAME good, ranked by score (quote flow). */
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
        priceMinor: { not: null },
      },
      select: SELLER_SELECT,
      orderBy: { updatedAt: "desc" },
      take: 50, // bounded scan; final ranking happens in memory
    });

    return rows
      .map((row) => {
        const b = row.business;
        const priceMinor = row.priceMinor as number;
        const minOrder = row.minOrder ?? 0;
        const score = matchScore(buyerCity, b.city, volume, minOrder);
        return {
          sellerId: b.id,
          sellerName: b.name,
          sellerSlug: b.slug,
          sellerCity: b.city,
          sellerVerified: b.isVerified,
          listingId: row.id,
          priceMinor,
          currency: row.currency,
          minOrder,
          score,
          isSpecial: score >= 90,
        };
      })
      .sort((a, b) => b.score - a.score || a.priceMinor - b.priceMinor)
      .slice(0, limit);
  }

  /** Buyers looking for goods I sell — the buy-tab strip. */
  async buyersForSeller(sellerBusinessId: string, sellerCity: string, limit = 12): Promise<BuyerMatch[]> {
    const mySellListings = await this.prisma.listing.findMany({
      where: { businessId: sellerBusinessId, mode: { in: ["SELL", "BOTH"] }, priceMinor: { not: null } },
      select: { goodId: true, minOrder: true, stock: true },
    });
    if (mySellListings.length === 0) return [];

    const goodIds = [...new Set(mySellListings.map((l) => l.goodId))];
    const capByGood = new Map(mySellListings.map((l) => [l.goodId, { min: l.minOrder ?? 0, cap: l.stock ?? 0 }]));

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
        updatedAt: true,
        good: { select: { id: true, nameFa: true, nameEn: true, unit: true } },
        business: { select: { id: true, slug: true, name: true, city: true, isVerified: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 120,
    });

    return buyRows
      .map((row) => {
        const b = row.business;
        const volume = row.volume as number;
        const cap = capByGood.get(row.good.id) ?? { min: 0, cap: 0 };
        let score = matchScore(b.city, sellerCity, volume, cap.min);
        // a buyer far beyond my capacity is not my match
        if (cap.cap > 0 && volume > cap.cap * 3) score -= 12;
        score += Math.round(recencyScore(row.updatedAt) / 2);
        return {
          buyerId: b.id,
          buyerName: b.name,
          buyerSlug: b.slug,
          buyerCity: b.city,
          buyerVerified: b.isVerified,
          buyListingId: row.id,
          goodId: row.good.id,
          goodName: row.good.nameFa,
          unit: row.good.unit,
          volume,
          frequency: row.frequency as string,
          score: Math.max(42, Math.min(98, Math.round(score))),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Suppliers selling goods I need — the sell-tab strip. */
  async suppliersForBuyer(
    buyerBusinessId: string,
    buyerCity: string,
    limit = 12
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
    const volumeByGood = new Map(myBuyListings.map((l) => [l.goodId, l.volume as number]));

    const sellRows = await this.prisma.listing.findMany({
      where: {
        goodId: { in: goodIds },
        businessId: { not: buyerBusinessId },
        mode: { in: ["SELL", "BOTH"] },
        priceMinor: { not: null },
      },
      select: {
        id: true,
        priceMinor: true,
        currency: true,
        minOrder: true,
        stock: true,
        updatedAt: true,
        good: { select: { id: true, nameFa: true, nameEn: true, unit: true } },
        business: { select: { id: true, slug: true, name: true, city: true, isVerified: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 150,
    });

    // price rank inside each same-good group (cheapest gets the boost)
    const pricePts = priceRanks(
      sellRows.map((r) => ({ id: r.id, priceMinor: r.priceMinor, goodId: r.good.id }))
    );

    return sellRows
      .map((row) => {
        const b = row.business;
        let score = matchScore(buyerCity, b.city, volumeByGood.get(row.good.id) ?? 0, row.minOrder ?? 0);
        // a supplier whose capacity is far below my need is not my match
        if ((row.stock ?? 0) > 0 && (volumeByGood.get(row.good.id) ?? 0) > (row.stock as number) * 3) score -= 10;
        score += Math.round(recencyScore(row.updatedAt) / 2) + (pricePts.get(row.id) ?? 0) / 3;
        return {
          supplierId: b.id,
          supplierName: b.name,
          supplierSlug: b.slug,
          supplierCity: b.city,
          supplierVerified: b.isVerified,
          listingId: row.id,
          goodId: row.good.id,
          goodName: row.good.nameFa,
          unit: row.good.unit,
          priceMinor: row.priceMinor as number,
          currency: row.currency,
          minOrder: row.minOrder ?? 0,
          score: Math.max(42, Math.min(98, Math.round(score))),
        };
      })
      .sort((a, b) => b.score - a.score || a.priceMinor - b.priceMinor)
      .slice(0, limit);
  }

  /**
   * Buy-requests list for the current user:
   *   seller → requests of the goods I sell (volume fit > proximity > recency)
   *   buyer  → requests of the goods I buy, same-level peers (similarity > proximity > recency)
   *   empty  → the whole market (proximity > recency)
   */
  async buyRequestsFor(businessId: string, city: string, limit = 60): Promise<RankedRow[]> {
    const [mySell, myBuy, rows] = await Promise.all([
      this.prisma.listing.findMany({
        where: { businessId, mode: { in: ["SELL", "BOTH"] } },
        select: { goodId: true, minOrder: true, stock: true },
      }),
      this.prisma.listing.findMany({
        where: { businessId, mode: { in: ["BUY", "BOTH"] }, volume: { not: null } },
        select: { goodId: true, volume: true },
      }),
      this.prisma.listing.findMany({
        where: {
          mode: { in: ["BUY", "BOTH"] },
          volume: { not: null },
          businessId: { not: businessId },
        },
        select: RANK_SELECT,
        orderBy: { updatedAt: "desc" },
        take: 300,
      }),
    ]);

    let ranked: RankedRow[];

    if (mySell.length > 0) {
      const capByGood = new Map(mySell.map((l) => [l.goodId, { min: l.minOrder ?? 0, cap: l.stock ?? 0 }]));
      const goodIds = new Set(capByGood.keys());
      ranked = rows
        .filter((r) => goodIds.has(r.good.id))
        .map((r) => {
          const cap = capByGood.get(r.good.id) as { min: number; cap: number };
          return {
            ...r,
            score:
              volumeFit(cap.min, cap.cap, r.volume as number) +
              proxPoints(city, r.business.city, 24, 14, 4) +
              recencyScore(r.updatedAt),
          };
        });
    } else if (myBuy.length > 0) {
      const volByGood = new Map(myBuy.map((l) => [l.goodId, l.volume as number]));
      const goodIds = new Set(volByGood.keys());
      ranked = rows
        .filter((r) => goodIds.has(r.good.id))
        .map((r) => {
          const myV = volByGood.get(r.good.id) as number;
          const v = r.volume as number;
          const sim = v >= myV / 5 && v <= myV * 5 ? 30 : 0; // same-level buyer first
          return {
            ...r,
            score: sim + proxPoints(city, r.business.city, 18, 11, 4) + recencyScore(r.updatedAt),
          };
        });
    } else {
      ranked = rows.map((r) => ({
        ...r,
        score: proxPoints(city, r.business.city, 20, 12, 4) + recencyScore(r.updatedAt),
      }));
    }

    return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Sell-offers list for the current user:
   *   buyer  → offers of the goods I need (capacity fit > price > proximity > recency)
   *   seller → offers of the goods I sell — competitor prices (proximity > price > recency)
   *   empty  → the whole market
   */
  async sellOffersFor(businessId: string, city: string, limit = 60): Promise<RankedRow[]> {
    const [myBuy, mySell, rows] = await Promise.all([
      this.prisma.listing.findMany({
        where: { businessId, mode: { in: ["BUY", "BOTH"] }, volume: { not: null } },
        select: { goodId: true, volume: true },
      }),
      this.prisma.listing.findMany({
        where: { businessId, mode: { in: ["SELL", "BOTH"] } },
        select: { goodId: true },
      }),
      this.prisma.listing.findMany({
        where: {
          mode: { in: ["SELL", "BOTH"] },
          priceMinor: { not: null },
          businessId: { not: businessId },
        },
        select: RANK_SELECT,
        orderBy: { updatedAt: "desc" },
        take: 300,
      }),
    ]);

    const pricePts = priceRanks(rows.map((r) => ({ id: r.id, priceMinor: r.priceMinor, goodId: r.good.id })));
    let ranked: RankedRow[];

    if (myBuy.length > 0) {
      const needByGood = new Map(myBuy.map((l) => [l.goodId, l.volume as number]));
      const goodIds = new Set(needByGood.keys());
      ranked = rows
        .filter((r) => goodIds.has(r.good.id))
        .map((r) => {
          const myV = needByGood.get(r.good.id) as number;
          return {
            ...r,
            score:
              capacityFit(r.minOrder ?? 0, r.stock ?? 0, myV) +
              (pricePts.get(r.id) ?? 0) +
              proxPoints(city, r.business.city, 14, 9, 3) +
              recencyScore(r.updatedAt),
          };
        });
    } else if (mySell.length > 0) {
      const goodIds = new Set(mySell.map((l) => l.goodId));
      ranked = rows
        .filter((r) => goodIds.has(r.good.id))
        .map((r) => ({
          ...r,
          score:
            proxPoints(city, r.business.city, 14, 9, 3) +
            (pricePts.get(r.id) ?? 0) +
            recencyScore(r.updatedAt),
        }));
    } else {
      ranked = rows.map((r) => ({
        ...r,
        score: proxPoints(city, r.business.city, 14, 9, 3) + recencyScore(r.updatedAt),
      }));
    }

    return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
