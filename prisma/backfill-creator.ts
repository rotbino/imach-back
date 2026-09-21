/**
 * One-off backfill — rows created before the creatorRole field existed:
 *   source = "USER"  →  creatorRole = "USER"
 * Seed rows (source = "SEED") stay null = system.
 * Idempotent: only touches rows where creatorRole is still unset.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const goods = await prisma.good.updateMany({
    where: { source: "USER", creatorRole: null },
    data: { creatorRole: "USER" },
  });
  const brands = await prisma.brand.updateMany({
    where: { source: "USER", creatorRole: null },
    data: { creatorRole: "USER" },
  });
  console.log(`backfill done — goods: ${goods.count}, brands: ${brands.count}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
