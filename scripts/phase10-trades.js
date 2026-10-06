/*
 * Phase 10 — Trade registry migration (بازخورد مالک: اصناف از دیتابیس).
 *
 *   ۱) ۴ صنفِ هسته‌ایِ ثبت‌نام را می‌سازد/تضمین می‌کند (ترتیب مهم است):
 *      سوپرمارکت · پخش مواد غذایی · تولید پوشاک · قنادی
 *   ۲) اصنافِ موجودِ کسب‌وکارها را به رجیستری backfill می‌کند (usageCount
 *      = تعداد کسب‌وکار همان صنف) و tradeId همه را پیوند می‌زند.
 *   ۳) اصنافِ هم‌املا (ي/ك عربی، نیم‌فاصله/فاصله، case) را ادغام می‌کند —
 *      کسب‌وکارها به رکوردِ برنده منتقل و نام آن استاندارد می‌شود.
 *
 * Ensure/Repair: هر اجرا وضعیت را «درست» می‌کند؛ اجرای دوباره بی‌ضرر است.
 * اجرا: node scripts/phase10-trades.js
 * (پیش‌نیاز: prisma db push — فیلد Business.tradeId + مدل Trade)
 */
require("dotenv").config();
if (process.env.MONGO_URL) process.env.DATABASE_URL = process.env.MONGO_URL;
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

/** همان نرمال‌سازی سرور — trim + ي→ی + ك→ک + نیم‌فاصله→فاصله + casefold */
function norm(name) {
  return String(name)
    .trim()
    .replace(/[ي]/g, "ی")
    .replace(/[ك]/g, "ک")
    .replace(/\u200c/g, " ")
    .toLocaleLowerCase("fa");
}

const CORE_TRADES = ["سوپرمارکت", "پخش مواد غذایی", "تولید پوشاک", "قنادی"];

async function main() {
  console.log("── Phase 10: Trade registry ──");

  // ۱) اصناف هسته‌ای
  for (const name of CORE_TRADES) {
    const hit = await prisma.trade.findFirst({ where: { name } });
    if (hit && !hit.isCore) {
      await prisma.trade.update({ where: { id: hit.id }, data: { isCore: true } });
      console.log(`• core: ${name} (promoted)`);
    } else if (!hit) {
      await prisma.trade.create({ data: { name, isCore: true, usageCount: 0 } });
      console.log(`• core: ${name} (created)`);
    } else {
      console.log(`• core: ${name} (ok)`);
    }
  }

  // ۲) backfill — همه کسب‌وکارهای دارای صنف متنّی
  const bizs = await prisma.business.findMany({
    where: { trade: { not: null } },
    select: { id: true, trade: true, tradeId: true },
  });
  console.log(`• businesses with trade text: ${bizs.length}`);

  // نام → رکورد برنده (اولین ایجاد)؛ شمارش استفاده
  const byNorm = new Map();
  const all = await prisma.trade.findMany();
  for (const t of all) byNorm.set(norm(t.name), t);

  for (const b of bizs) {
    const n = norm(b.trade);
    if (!n) continue;
    let row = byNorm.get(n);
    if (!row) {
      row = await prisma.trade.create({ data: { name: b.trade.trim(), usageCount: 0 } });
      byNorm.set(n, row);
      console.log(`  + new trade: ${row.name}`);
    }
    await prisma.business.update({
      where: { id: b.id },
      data: { tradeId: row.id, trade: row.name },
    });
  }

  // ۳) شمارش واقعی استفاده (idempotent — هر بار از صفر جمع می‌زند)
  const rows = await prisma.trade.findMany({ select: { id: true } });
  for (const t of rows) {
    const count = await prisma.business.count({ where: { tradeId: t.id } });
    await prisma.trade.update({ where: { id: t.id }, data: { usageCount: count } });
  }

  // ۴) ادغام رکوردهای هم‌املا که موازی ساخته شده‌اند
  const every = await prisma.trade.findMany();
  const seen = new Map();
  const merges = [];
  for (const t of every) {
    const n = norm(t.name);
    if (seen.has(n)) {
      const winner = seen.get(n);
      if (winner.id !== t.id) merges.push([winner, t]);
    } else {
      seen.set(n, t);
    }
  }
  for (const [winner, dup] of merges) {
    await prisma.business.updateMany({ where: { tradeId: dup.id }, data: { tradeId: winner.id } });
    await prisma.trade.delete({ where: { id: dup.id } });
    console.log(`  merged: «${dup.name}» → «${winner.name}»`);
  }

  const total = await prisma.trade.count();
  console.log(`── done: ${total} trades in registry ──`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
