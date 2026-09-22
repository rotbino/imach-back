/**
 * One-shot migration: local Iranian phone identities → international identity.
 *   users     09xxxxxxxxx → 989xxxxxxxxx   (+ language backfill "fa")
 *   contacts  09xxxxxxxxx → 989xxxxxxxxx   (member matching stays exact)
 *   businesses 09xxxxxxxxx → 989xxxxxxxxx  (catalog contact numbers)
 * Idempotent: only rows still starting with "0" are touched.
 * Run:  cd /home/z/imach-back && node scripts/migrate-intl-phones.js
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const toIntl = (phone) => "98" + phone.slice(1);

async function migrate() {
  let users = 0;
  const rows = await prisma.user.findMany({
    where: { phone: { startsWith: "0" } },
    select: { id: true, phone: true },
  });
  for (const u of rows) {
    if (!/^09\d{9}$/.test(u.phone)) continue;
    try {
      await prisma.user.update({
        where: { id: u.id },
        data: { phone: toIntl(u.phone), language: "fa" },
      });
      users++;
    } catch (e) {
      console.error(`user ${u.phone} skipped: ${e.message}`);
    }
  }

  let contacts = 0;
  const crows = await prisma.contact.findMany({
    where: { phone: { startsWith: "0" } },
    select: { id: true, phone: true },
  });
  for (const c of crows) {
    if (!/^09\d{9}$/.test(c.phone)) continue;
    try {
      await prisma.contact.update({ where: { id: c.id }, data: { phone: toIntl(c.phone) } });
      contacts++;
    } catch (e) {
      console.error(`contact ${c.phone} skipped: ${e.message}`);
    }
  }

  let businesses = 0;
  const brows = await prisma.business.findMany({
    where: { phone: { startsWith: "0" } },
    select: { id: true, phone: true },
  });
  for (const b of brows) {
    if (!/^09\d{9}$/.test(b.phone)) continue;
    try {
      await prisma.business.update({ where: { id: b.id }, data: { phone: toIntl(b.phone) } });
      businesses++;
    } catch (e) {
      console.error(`business ${b.phone} skipped: ${e.message}`);
    }
  }

  console.log(`migrated: ${users} users, ${contacts} contacts, ${businesses} businesses`);
}

migrate()
  .catch((e) => {
    console.error("migration failed:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
