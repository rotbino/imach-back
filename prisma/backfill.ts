/** One-off backfill: stamp createdAt/updatedAt on legacy Business documents. */
import { PrismaClient } from "@prisma/client";

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const now = new Date();
  const res = await prisma.business.updateMany({ data: { createdAt: now, updatedAt: now } });
  console.log("backfilled businesses:", res.count);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
