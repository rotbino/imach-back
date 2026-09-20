/**
 * One-shot cleanup — removes every remnant of the abandoned sells/buys design
 * so the Business collection stays clean and minimal (user's cleanup law).
 *
 *  1) documents that still carry the ancient `role` key donate it to
 *     `activityType` (the old 4 roles are a subset of the 10 allowed values)
 *  2) the dead keys `sells` / `buys` / `role` are unset from ALL businesses
 *
 * Run once:  npx tsx prisma/cleanup-arms.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log("Cleaning Business remnants (sells / buys / role) …");

  // 1) role → activityType (only where activityType is not set yet)
  const migrated = await prisma.$runCommandRaw({
    update: "Business",
    updates: [
      {
        q: { role: { $exists: true }, activityType: { $exists: false } },
        u: [{ $set: { activityType: "$role" } }],
        multi: true,
      },
    ],
  });
  console.log("  role → activityType:", JSON.stringify(migrated));

  // 2) strip the abandoned keys everywhere
  const stripped = await prisma.$runCommandRaw({
    update: "Business",
    updates: [{ q: {}, u: { $unset: { sells: "", buys: "", role: "" } }, multi: true }],
  });
  console.log("  unset sells/buys/role:", JSON.stringify(stripped));

  console.log("Cleanup complete.");
}

main()
  .catch((e) => {
    console.error("Cleanup failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
