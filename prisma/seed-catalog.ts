/**
 * Catalog seed v2 — the product-based taxonomy wave 1. (BULK version: all
 * dedup/migration decisions are computed in memory, writes go out in batches.)
 *
 * Order of operations (idempotent — safe to re-run):
 *  1) migrate legacy goods (v1 leaves) to their v2 leaf by name
 *  2) upsert the v2 tree (hidden services subtree included, isActive=false)
 *  3) upsert reference goods (deduped by normalized searchText)
 *  4) move any leftover goods of dead v1 leaves to a v2 fallback
 *  5) delete dead v1 category nodes (leaf-first)
 *
 * Run: DATABASE_URL=… npx tsx prisma/seed-catalog.ts
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { TREE, HIDDEN_TREE, LEGACY_GOOD_MOVES, LEGACY_ROOT_FALLBACK } from "./catalog-tree";
import { GOODS_A, type GoodSeed } from "./catalog-goods-a";
import { GOODS_B } from "./catalog-goods-b";

const prisma = new PrismaClient();

const GOODS: Record<string, GoodSeed[]> = { ...GOODS_A, ...GOODS_B };

function normalize(s: string): string {
  return s
    .trim()
    .replace(/[\u064A\u0649]/g, "\u06CC") // ي ى → ی
    .replace(/\u0643/g, "\u06A9") // ك → ک
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "") // harakat + tatweel
    .replace(/\u200C/g, " ") // ZWNJ → space
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0)) // ۰-۹
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)) // ٠-٩
    .replace(/\s+/g, " ")
    .toLowerCase();
}

async function main(): Promise<void> {
  console.log("Catalog seed v2 …");

  // ── in-memory index of every existing good (id + searchText + leaf + name) ─
  const allGoods = await prisma.good.findMany({
    select: { id: true, searchText: true, categoryId: true, nameFa: true },
    orderBy: { id: "asc" }, // ObjectId = time-ordered
  });
  const bySearchText = new Map<string, string>(); // normalized → good id
  const byLeafName = new Map<string, string>(); // categoryId|normalizedName → id (oldest wins)
  for (const g of allGoods) {
    bySearchText.set(g.searchText, g.id);
    const key = `${g.categoryId}|${normalize(g.nameFa)}`;
    if (!byLeafName.has(key)) byLeafName.set(key, g.id);
  }
  console.log(`  ${allGoods.length} existing goods indexed`);

  // ── 1) legacy goods → v2 leaf (by name) ─────────────────────────────────
  let moved = 0;
  const moveTargets = new Map<string, string[]>(); // target slug → good ids
  for (const [name, newSlug] of Object.entries(LEGACY_GOOD_MOVES)) {
    const norm = normalize(name);
    // legacy searchText = normalize(name + en + aliases) → exact-or-prefix match
    for (const [st, id] of bySearchText) {
      if (st === norm || st.startsWith(`${norm} `)) {
        moveTargets.set(newSlug, [...(moveTargets.get(newSlug) ?? []), id]);
      }
    }
  }
  // target categories may not exist yet — resolve AFTER tree upsert, so the
  // actual updates happen in step 3.5 (see below).
  console.log(`  queued ${[...moveTargets.values()].reduce((n, v) => n + v.length, 0)} legacy-goods moves by name`);

  // ── 2) v2 tree upsert (roots → leaves, hidden services included) ────────
  const catIds = new Map<string, string>(); // slug → id
  async function upsertRoot(r: (typeof TREE)[number], isActive: boolean): Promise<void> {
    const root = await prisma.category.upsert({
      where: { slug: r.slug },
      create: { slug: r.slug, nameFa: r.nameFa, nameEn: r.nameEn, isActive, unit: null },
      update: { nameFa: r.nameFa, nameEn: r.nameEn, isActive, parentId: null },
    });
    catIds.set(r.slug, root.id);
    for (const leaf of r.children) {
      const row = await prisma.category.upsert({
        where: { slug: leaf.slug },
        create: { slug: leaf.slug, nameFa: leaf.nameFa, nameEn: leaf.nameEn, parentId: root.id, unit: leaf.unit, attrs: (leaf.attrs ?? undefined) as Prisma.InputJsonValue | undefined, isActive },
        update: { nameFa: leaf.nameFa, nameEn: leaf.nameEn, parentId: root.id, unit: leaf.unit, attrs: (leaf.attrs ?? undefined) as Prisma.InputJsonValue | undefined, isActive },
      });
      catIds.set(leaf.slug, row.id);
    }
  }
  for (const r of TREE) await upsertRoot(r, true);
  for (const r of HIDDEN_TREE) await upsertRoot(r, false);
  console.log(`  ok ${catIds.size} v2 categories (incl. hidden)`);

  // 1b) apply the queued legacy moves (bulk per target leaf)
  for (const [slug, ids] of moveTargets) {
    const target = catIds.get(slug);
    if (!target) continue;
    await prisma.good.updateMany({ where: { id: { in: ids } }, data: { categoryId: target } });
    moved += ids.length;
  }
  console.log(`  moved ${moved} legacy goods by name`);

  // ── 3) reference goods create (deduped in memory, batched writes) ───────
  const unitByLeaf = new Map<string, string | null>();
  const leaves = await prisma.category.findMany({ select: { id: true, unit: true } });
  for (const l of leaves) unitByLeaf.set(l.id, l.unit);

  let created = 0;
  let existing = 0;
  const buffer: Parameters<typeof prisma.good.create>[0]["data"][] = [];
  const flush = async (): Promise<void> => {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, 40);
      await prisma.$transaction(batch.map((data) => prisma.good.create({ data })));
    }
  };
  for (const [leafSlug, items] of Object.entries(GOODS)) {
    const leafId = catIds.get(leafSlug);
    if (!leafId) {
      console.warn(`  ! leaf missing for goods group: ${leafSlug}`);
      continue;
    }
    for (const g of items) {
      const searchText = normalize([g.n, g.e ?? "", ...(g.a ?? [])].filter(Boolean).join(" "));
      if (bySearchText.has(searchText) || byLeafName.has(`${leafId}|${normalize(g.n)}`)) {
        existing++;
        continue;
      }
      bySearchText.set(searchText, "pending");
      byLeafName.set(`${leafId}|${normalize(g.n)}`, "pending");
      buffer.push({
        categoryId: leafId,
        nameFa: g.n,
        nameEn: g.e ?? null,
        aliases: g.a ?? [],
        searchText,
        unit: g.u ?? unitByLeaf.get(leafId) ?? "PIECE",
        source: "SEED",
        status: g.p ? "PROVISIONAL" : "ACTIVE",
      });
      created++;
    }
  }
  await flush();
  console.log(`  goods: +${created} created, ${existing} already existed`);

  // ── 3.5) dedupe: same leaf + same nameFa → keep one, re-point listings ──
  const listingCounts = new Map<string, number>();
  for (const row of await prisma.listing.groupBy({ by: ["goodId"], _count: { _all: true } })) {
    listingCounts.set(row.goodId, row._count._all);
  }
  const allNow = await prisma.good.findMany({ select: { id: true, categoryId: true, nameFa: true } });
  const groups = new Map<string, { id: string; nameFa: string; listings: number }[]>();
  for (const g of allNow) {
    const key = `${g.categoryId}|${normalize(g.nameFa)}`;
    groups.set(key, [...(groups.get(key) ?? []), { id: g.id, nameFa: g.nameFa, listings: listingCounts.get(g.id) ?? 0 }]);
  }
  let merged = 0;
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    // keep the row with the most listings; ties → the oldest (legacy history wins)
    group.sort((a, b) => b.listings - a.listings); // id order already = creation order (ObjectId)
    const keeper = group[0];
    for (const dup of group.slice(1)) {
      if (dup.listings > 0) {
        await prisma.listing.updateMany({ where: { goodId: dup.id }, data: { goodId: keeper.id } });
      }
      await prisma.good.delete({ where: { id: dup.id } });
      merged++;
    }
  }
  console.log(`  merged ${merged} duplicate goods`);

  // ── 4) leftovers of dead v1 leaves → v2 fallback ────────────────────────
  const legacyCats = await prisma.category.findMany({ select: { id: true, slug: true } });
  const deadSlugs = legacyCats.filter((c) => !catIds.has(c.slug));
  let fallbackMoves = 0;
  for (const dead of deadSlugs) {
    const orphans = await prisma.good.findMany({ where: { categoryId: dead.id }, select: { id: true } });
    if (orphans.length === 0) continue;
    const fallbackSlug = LEGACY_ROOT_FALLBACK[dead.slug];
    const fallback = fallbackSlug ? catIds.get(fallbackSlug) : undefined;
    if (!fallback) {
      console.warn(`  ! no fallback for legacy slug ${dead.slug} (${orphans.length} goods)`);
      continue;
    }
    await prisma.good.updateMany({ where: { id: { in: orphans.map((o) => o.id) } }, data: { categoryId: fallback } });
    fallbackMoves += orphans.length;
  }
  console.log(`  fallback-moved ${fallbackMoves} leftover goods`);

  // ── 5) delete dead v1 nodes (leaf-first: never destroy live data) ───────
  let deleted = 0;
  for (const dead of deadSlugs) {
    const children = await prisma.category.count({ where: { parentId: dead.id } });
    const goods = await prisma.good.count({ where: { categoryId: dead.id } });
    if (children > 0 || goods > 0) continue;
    await prisma.category.delete({ where: { id: dead.id } });
    deleted++;
  }
  console.log(`  deleted ${deleted} dead v1 nodes`);
  console.log("Catalog seed v2 done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
