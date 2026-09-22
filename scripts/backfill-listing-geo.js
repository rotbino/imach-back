/**
 * Backfill existing listings after the matching-optimization migration:
 *   1) geo snapshot (city/province/country) from the owning business
 *   2) variantKey/variantLabel derived from attrs + category attr defs
 * Idempotent — safe to re-run. Run AFTER `prisma db push`.
 *   set -a && . ./.env && set +a && node scripts/backfill-listing-geo.js
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const IRAN_CITY_PROVINCE = require("../src/common/geo/iran.json");

function deriveVariantKey(attrs) {
  if (!attrs) return "";
  return Object.keys(attrs)
    .sort()
    .map((k) => `${k}=${attrs[k]}`)
    .join("|")
    .slice(0, 60);
}

function deriveVariantLabel(attrs, defs) {
  if (!attrs) return null;
  const parts = [];
  for (const [k, v] of Object.entries(attrs)) {
    const opt = (defs || []).find((d) => d.key === k)?.options?.find((o) => o.v === v);
    parts.push(opt ? opt.fa : v);
  }
  const label = parts.filter(Boolean).join(" · ").slice(0, 80);
  return label || null;
}

(async () => {
  // flat reads — some legacy rows reference deleted goods/businesses, which
  // breaks Prisma relation joins; maps keep the backfill tolerant.
  const [listings, businesses, goods] = await Promise.all([
    prisma.listing.findMany({
      select: { id: true, city: true, variantKey: true, attrs: true, goodId: true, businessId: true },
    }),
    prisma.business.findMany({ select: { id: true, city: true, province: true, country: true } }),
    prisma.good.findMany({ select: { id: true, category: { select: { attrs: true } } } }),
  ]);
  const bizById = new Map(businesses.map((b) => [b.id, b]));
  const catByGoodId = new Map(goods.map((g) => [g.id, g.category?.attrs ?? null]));

  let geoFixed = 0;
  let variantFixed = 0;
  for (const l of listings) {
    const biz = bizById.get(l.businessId);
    const defs = catByGoodId.get(l.goodId);
    const data = {};
    if (l.city === null && biz?.city) {
      data.city = biz.city;
      data.province = biz.province ?? IRAN_CITY_PROVINCE[biz.city] ?? null;
      data.country = biz.country ?? "IR";
      geoFixed++;
    }
    const wantedKey = deriveVariantKey(l.attrs ?? null);
    if (l.variantKey !== wantedKey) {
      data.variantKey = wantedKey;
      data.variantLabel = deriveVariantLabel(l.attrs ?? null, defs);
      variantFixed++;
    }
    if (Object.keys(data).length > 0) {
      await prisma.listing.update({ where: { id: l.id }, data });
    }
  }
  console.log(`listings=${listings.length} geoBackfilled=${geoFixed} variantBackfilled=${variantFixed}`);
  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
