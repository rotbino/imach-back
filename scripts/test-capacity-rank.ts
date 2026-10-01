/**
 * Capacity-fit smoke: suppliersForNeed must rank real-capacity sellers above
 * thin ones for a large request — without dropping anyone from the list.
 * Run: DATABASE_URL=… npx tsx scripts/test-capacity-rank.ts
 */
import { MatchingService } from "../src/market/matching.service";

const rows = [
  mk("A-thin-1kg", 1),
  mk("B-real-500t", 500_000),
  mk("C-legacy-null", null),
  mk("D-stretch-150t", 150_000),
];
function mk(id: string, stock: number | null) {
  return {
    id,
    priceMinor: 1000,
    currency: "IRR",
    minOrder: 0,
    stock,
    city: "tehran",
    province: "tehran",
    country: "ir",
    business: { id, slug: id, name: id, city: "tehran", isVerified: false },
  };
}

const prismaStub = {
  listing: { findMany: async () => rows },
} as unknown as never;

async function main() {
  const svc = new MatchingService(prismaStub);
  const geo = { city: "tehran", province: "tehran", country: "ir" };

  const out = await svc.suppliersForNeed("me", geo, "goodX", 200_000, 10);
  console.log(out.map((m) => `${m.sellerName.padEnd(16)} score=${m.score} stock=${m.stock}`).join("\n"));

  const names = out.map((m) => m.sellerName);
  const ok =
    names[0] === "B-real-500t" && // comfortably in stock wins
    names.indexOf("D-stretch-150t") < names.indexOf("A-thin-1kg") && // stretch (-5) beats far-beyond (-12)
    names.indexOf("C-legacy-null") < names.indexOf("A-thin-1kg") && // neutral (0) beats far-beyond (-12)
    names.length === 4; // nobody dropped
  console.log(ok ? "RANK_OK" : "RANK_FAIL");
  process.exit(ok ? 0 : 1);
}
void main();
