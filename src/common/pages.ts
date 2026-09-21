import { PrismaService } from "./prisma/prisma.module";

/**
 * Returns the (businessId, type) page, creating it on first touch.
 * MVP: one SELL + one BUY page per business — the unique index keeps the
 * lazy creation race-safe. Future page types plug in without migrations.
 */
export async function ensurePage(
  prisma: PrismaService,
  businessId: string,
  type: "SELL" | "BUY"
): Promise<string> {
  const existing = await prisma.page.findUnique({
    where: { businessId_type: { businessId, type } },
    select: { id: true },
  });
  if (existing) return existing.id;
  try {
    const created = await prisma.page.create({ data: { businessId, type }, select: { id: true } });
    return created.id;
  } catch {
    // concurrent creation lost the race — the winner's row is the answer
    const winner = await prisma.page.findUniqueOrThrow({
      where: { businessId_type: { businessId, type } },
      select: { id: true },
    });
    return winner.id;
  }
}
