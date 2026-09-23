import { Injectable } from "@nestjs/common";
import { matchScore, proximity, type GeoSpot, type Proximity } from "../common/geo/cities";
import { PrismaService } from "../common/prisma/prisma.module";

/**
 * Matching engine — a match requires the SAME reference good;
 * the score adds order-size fit, price rank, proximity (city >
 * province > country) and recency. Results are persisted on each Offer row
 * so the history stays meaningful even when the algorithm evolves.
 *
 * Scale contract: every scan filters isActive listings directly and carries
 * the geo snapshot of the listing itself (falling back to the business for
 * legacy rows) — no app-side business joins for the hot paths.
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
  /** the seller's capacity signal for this good — feeds volume-fit ranking (null = legacy row) */
  stock: number | null;
  score: number;
  isSpecial: boolean;
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

/** A ranked listing row for the personalized sell-side demand list. */
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
  };
  score: number;
}

const SELLER_SELECT = {
  id: true,
  priceMinor: true,
  currency: true,
  minOrder: true,
  stock: true,
  city: true,
  province: true,
  country: true,
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
  city: true,
  province: true,
  country: true,
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
 * Capacity adjustment for the QUOTE flow, calibrated to matchScore's 0–98
 * scale (isSpecial ≥ 90 must keep its meaning). Rank modifier, never a
 * filter — a seller who cannot fill the volume slides down, not out:
 *   need far beyond stock (×2) → −12 · need stretches stock → −5 ·
 *   comfortably in stock → +3 · unknown stock (legacy) → neutral.
 * volumeFit stays exclusive to the buy-requests list, where fit is THE
 * dominant factor — mixing the two scales would corrupt both.
 */
function capacityAdj(volume: number, stock: number | null): number {
  if (!stock || stock <= 0) return 0;
  if (volume > stock * 2) return -12;
  if (volume > stock) return -5;
  return 3;
}

/** GeoSpot of a listing row — the snapshot, with business fallback for legacy rows. */
function spotOf(row: { city: string | null; province: string | null; country: string | null; business: { city: string } }): GeoSpot {
  return {
    city: row.city ?? row.business.city,
    province: row.province,
    country: row.country,
  };
}

/** Proximity points for the ranked lists. */
function proxPoints(mine: GeoSpot, theirs: GeoSpot, same: number, near: number, far: number): number {
  const p: Proximity = proximity(mine, theirs);
  return p === "same-city" ? same : p === "same-province" ? near : far;
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
    buyerGeo: GeoSpot,
    goodId: string,
    volume: number,
    limit = 5
  ): Promise<SupplierMatch[]> {
    const rows = await this.prisma.listing.findMany({
      where: {
        goodId,
        isActive: true,
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
        // existing min-order rule + capacity reality — a 1-kg seller must not
        // tie a 200-ton supplier for a 200-ton request, but neither vanishes
        const score = matchScore(buyerGeo, spotOf(row), volume, minOrder) + capacityAdj(volume, row.stock);
        return {
          sellerId: b.id,
          sellerName: b.name,
          sellerSlug: b.slug,
          sellerCity: row.city ?? b.city,
          sellerVerified: b.isVerified,
          listingId: row.id,
          priceMinor,
          currency: row.currency,
          minOrder,
          stock: row.stock,
          score,
          isSpecial: score >= 90,
        };
      })
      .sort((a, b) => b.score - a.score || a.priceMinor - b.priceMinor)
      .slice(0, limit);
  }

  /** Suppliers selling goods I need — the sell-tab strip. */
  async suppliersForBuyer(
    buyerBusinessId: string,
    buyerGeo: GeoSpot,
    limit = 12
  ): Promise<SupplierSuggestion[]> {
    const myBuyListings = await this.prisma.listing.findMany({
      where: {
        businessId: buyerBusinessId,
        isActive: true,
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
        isActive: true,
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
        city: true,
        province: true,
        country: true,
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
        let score = matchScore(buyerGeo, spotOf(row), volumeByGood.get(row.good.id) ?? 0, row.minOrder ?? 0);
        // a supplier whose capacity is far below my need is not my match
        if ((row.stock ?? 0) > 0 && (volumeByGood.get(row.good.id) ?? 0) > (row.stock as number) * 3) score -= 10;
        score += Math.round(recencyScore(row.updatedAt) / 2) + (pricePts.get(row.id) ?? 0) / 3;
        return {
          supplierId: b.id,
          supplierName: b.name,
          supplierSlug: b.slug,
          supplierCity: row.city ?? b.city,
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
  async buyRequestsFor(businessId: string, myGeo: GeoSpot, limit = 60): Promise<RankedRow[]> {
    const [mySell, myBuy, rows] = await Promise.all([
      this.prisma.listing.findMany({
        where: { businessId, isActive: true, mode: { in: ["SELL", "BOTH"] } },
        select: { goodId: true, minOrder: true, stock: true },
      }),
      this.prisma.listing.findMany({
        where: { businessId, isActive: true, mode: { in: ["BUY", "BOTH"] }, volume: { not: null } },
        select: { goodId: true, volume: true },
      }),
      this.prisma.listing.findMany({
        where: {
          isActive: true,
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
              proxPoints(myGeo, spotOf(r), 24, 14, 4) +
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
            score: sim + proxPoints(myGeo, spotOf(r), 18, 11, 4) + recencyScore(r.updatedAt),
          };
        });
    } else {
      ranked = rows.map((r) => ({
        ...r,
        score: proxPoints(myGeo, spotOf(r), 20, 12, 4) + recencyScore(r.updatedAt),
      }));
    }

    return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
