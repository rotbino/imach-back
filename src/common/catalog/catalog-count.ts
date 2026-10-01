import type { PrismaService } from "../prisma/prisma.module";

/**
 * Denormalized catalog size of a business — the number that makes
 * «کپی از کاتالوگ هم‌صنف‌ها» instant: the search sorts by this counter
 * instead of groupBy-ing millions of listings per hit (قانون سرعت).
 * Kept fresh opportunistically on every listing write; one indexed count.
 */
export async function refreshCatalogCount(prisma: PrismaService, businessId: string): Promise<void> {
  try {
    const count = await prisma.listing.count({
      where: { businessId, isActive: true, mode: { in: ["SELL", "BOTH"] } },
    });
    await prisma.business.updateMany({
      where: { id: businessId, catalogCount: { not: count } },
      data: { catalogCount: count },
    });
  } catch {
    /* a counter must never break a write */
  }
}
