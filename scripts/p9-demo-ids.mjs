#!/usr/bin/env node
/** فاز ۹ — استخراج شناسه‌های نمونه برای صفحهٔ دمو از Atlas (فقط-خواندنی) */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const out = {};

async function main() {
  const buyer = await prisma.user.findFirst({ where: { phone: { startsWith: "98912404" } } });
  const seller = await prisma.user.findFirst({ where: { phone: { startsWith: "98912404" } , NOT: { id: buyer?.id } } });
  console.log("buyer:", buyer?.id, buyer?.phone);
  // any two real users
  const users = await prisma.user.findMany({ select: { id: true, phone: true }, take: 8 });
  console.log("users:", users.map(u => u.phone).join(" "));

  // watched good of the first user with a business
  const bizes = await prisma.business.findMany({ select: { id: true, slug: true, name: true, ownerId: true }, take: 10 });
  console.log("biz:", bizes.map(b => `${b.slug}(${b.name})`).join(" · "));

  const watched = await prisma.watchedGood.findMany({
    select: { goodId: true, good: { select: { id: true, nameFa: true } } },
    take: 5,
  });
  console.log("watched goods:", watched.map(w => `${w.good.id}:${w.good.nameFa}`).join(" · "));

  const sellList = await prisma.listing.findMany({
    where: { mode: { in: ["SELL", "BOTH"] } },
    select: { id: true, good: { select: { nameFa: true } }, business: { select: { slug: true, name: true } } },
    take: 6,
  });
  console.log("sell listings:", sellList.map(l => `${l.id}@${l.business.slug}(${l.good.nameFa})`).join(" · "));

  const buyList = await prisma.listing.findMany({
    where: { mode: { in: ["BUY", "BOTH"] } },
    select: { id: true, good: { select: { nameFa: true } }, business: { select: { slug: true } } },
    take: 4,
  });
  console.log("buy listings:", buyList.map(l => `${l.id}@${l.business.slug}`).join(" · "));

  const threads = await prisma.thread.findMany({ select: { id: true, aId: true, bId: true, lastText: true }, take: 5 });
  console.log("threads:", threads.map(t => `${t.id} last=${(t.lastText ?? "").slice(0, 18)}`).join(" · "));

  const inquiries = await prisma.inquiry.findMany({
    select: { id: true, kind: true, listingId: true, good: { select: { nameFa: true } } },
    take: 8, orderBy: { createdAt: "desc" },
  });
  console.log("inquiries:", inquiries.map(i => `${i.id}:${i.kind}:${i.listingId ?? ""}(${i.good?.nameFa ?? ""})`).join(" · "));

  const bizWithSlug = await prisma.business.findFirst({ where: { slug: { not: null } }, select: { slug: true } });
  console.log("sample slug:", bizWithSlug?.slug);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
