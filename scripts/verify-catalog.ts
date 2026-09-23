import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

async function main(): Promise<void> {
  const cats = await p.category.findMany({ select: { slug: true, nameFa: true, isActive: true, parentId: true } });
  const roots = cats.filter((c) => !c.parentId);
  console.log("roots:", roots.length, "| active roots:", roots.filter((r) => r.isActive).length, "| leaves:", cats.filter((c) => c.parentId).length);
  const dead = ["pantry", "drinks", "bakery-snacks", "steel", "copper", "metal-scrap", "plastic-scrap", "clothing", "fabric", "grains-legumes", "fruits-veg", "gold-items", "agri-food", "supermarket", "industry", "apparel", "gold"].filter((s) => cats.some((c) => c.slug === s));
  console.log("dead slugs left:", dead.join(",") || "none");
  console.log("hidden cats:", cats.filter((c) => c.isActive === false).map((c) => c.slug).join(","));
  const goods = await p.good.count();
  const prov = await p.good.count({ where: { status: "PROVISIONAL" } });
  const orphans = await p.good.count({ where: { category: { isActive: false } } });
  const noUnit = await p.category.count({ where: { parentId: { not: null }, unit: null } });
  console.log("goods:", goods, "| provisional:", prov, "| goods under hidden cat:", orphans, "| leaves without unit:", noUnit);
  const rice = await p.category.findUnique({ where: { slug: "rice" } });
  const riceGoods = await p.good.count({ where: { categoryId: rice!.id } });
  const listings = await p.listing.count();
  const listingsLive = await p.listing.count({ where: { isActive: true } });
  console.log("rice leaf goods:", riceGoods, "| listings:", listings, "(live:", listingsLive + ")");
  await p.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
