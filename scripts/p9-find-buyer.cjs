#!/usr/bin/env node
/** فاز ۹ — یافتن تلفن خریدار دمو (watcher) برای E2E */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

async function main() {
  const wg = await p.watchedGood.findFirst({
    select: { business: { select: { owner: { select: { phone: true } } } } },
  });
  console.log("watcher owner phone:", wg?.business?.owner?.phone ?? "none");
  const b = await p.business.findFirst({
    where: { slug: "d-rice-net-1" },
    select: { owner: { select: { phone: true } } },
  });
  console.log("d-rice-net-1 owner:", b?.owner?.phone ?? "none");
  // which users have a password (login-able)?
  const users = await p.user.findMany({
    where: { phone: { in: ["989196421264", "989100000447", "989155555555", "989222222222", "989333333333"] } },
    select: { phone: true, businesses: { select: { slug: true, name: true }, take: 1 } },
  });
  for (const u of users) {
    console.log(`phone=${u.phone} hasPassword=${!!u.password} biz=${u.businesses[0]?.slug ?? "-"} (${u.businesses[0]?.name ?? ""})`);
  }
}

main().catch((e) => console.error(e.message)).finally(() => p.$disconnect());
