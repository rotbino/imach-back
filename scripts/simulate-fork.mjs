/**
 * شبیه‌سازی داده‌ی قبل از فیکس — فقط دوقلوی هویت‌دار را می‌سازد:
 *   ردیف کهنه (productId null، گالری دارد) باید از قبل موجود باشد (مثلاً D
 *   که با saveListing ساخته شده)؛ این اسکریپت twin بی‌عکسِ productId-دار
 *   می‌سازد تا heal-forked-listings آن‌ها را یکی کند.
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const prisma = new PrismaClient();
const bizId = process.argv[2];
const goodId = process.argv[3];
if (!bizId || !goodId) {
  console.error("usage: node scripts/simulate-fork.mjs <businessId> <goodId>");
  process.exit(1);
}

const twin = await prisma.listing.create({
  data: {
    businessId: bizId,
    goodId,
    mode: "SELL",
    variantKey: `simfork-${randomBytes(4).toString("hex")}`,
    productId: (
      await prisma.product.create({
        data: { goodId, label: "دوقلوی شبیه‌سازی", searchText: `دوقلوی شبیه‌سازی-${randomBytes(3).toString("hex")}`, status: "PROVISIONAL", creatorRole: "USER" },
      })
    ).id,
    priceMinor: 124000,
    currency: "IRR",
    stock: 4,
    minOrder: 1,
    city: "تهران",
    country: "IR",
    isActive: true,
  },
});
console.log(JSON.stringify({ twin: twin.id }));
await prisma.$disconnect();
