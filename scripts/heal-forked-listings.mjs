/**
 * heal-forked-listings — یک‌بار پس از ارتقا اجرا شود:
 *   node scripts/heal-forked-listings.mjs
 *
 * پیش از فیکسِ «کلید هویت»، ویرایشِ یک آگهیِ قدیمی (یا ثبت همان کالا از
 * انتخابگر) به‌جای به‌روزرسانی، یک ردیفِ دوقلوی بی‌عکس می‌ساخت و عکس روی
 * ردیف قدیمی می‌ماند (خواسته‌ی کاربر: عکس بعد از ویرایش از کاتالوگ نیفتد).
 *
 * ملاک شناختِ همان پیشنهادِ فیزیکی: دو ردیف فعال از یک کسب‌وکار + یک گروه
 * کالا که یکی productId دارد و دیگری ندارد، ولی brandId و attrs یکسان‌اند.
 * گالری، تاریخچه قیمت، استعلام و پیشنهادها به ردیفِ هویت‌دار منتقل و ردیف
 * کهنه بازنشسته می‌شود (کلید یکتایش هم آزاد می‌شود).
 *
 * Idempotent — اجرای دوباره کاری نمی‌کند.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

// minimal .env loader — backend .env is gitignored and plain `node` doesn't read it
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* no .env — rely on the ambient environment */
}

const prisma = new PrismaClient();
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function main() {
  const keepers = await prisma.listing.findMany({
    where: { isActive: true, productId: { not: null } },
    select: { id: true, businessId: true, goodId: true, brandId: true, attrs: true },
  });

  let merged = 0;
  for (const keeper of keepers) {
    const dups = await prisma.listing.findMany({
      where: {
        businessId: keeper.businessId,
        goodId: keeper.goodId,
        isActive: true,
        productId: null,
        id: { not: keeper.id },
      },
      select: { id: true, brandId: true, attrs: true },
    });

    for (const dup of dups) {
      if ((dup.brandId ?? null) !== (keeper.brandId ?? null)) continue;
      if (!sameJson(dup.attrs, keeper.attrs)) continue;

      await prisma.file.updateMany({
        where: { relatedModel: "Listing", relatedId: dup.id },
        data: { relatedId: keeper.id },
      });
      await prisma.priceLog.updateMany({ where: { listingId: dup.id }, data: { listingId: keeper.id } });
      await prisma.inquiry.updateMany({ where: { listingId: dup.id }, data: { listingId: keeper.id } });
      await prisma.offer.updateMany({ where: { listingId: dup.id }, data: { listingId: keeper.id } });
      // variantKey part of the unique index — the retired row frees its slot
      await prisma.listing.update({
        where: { id: dup.id },
        data: { isActive: false, variantKey: `fork:${dup.id}` },
      });
      merged++;
      console.log(`merged ${dup.id} → ${keeper.id}`);
    }
  }

  console.log(`done — ${merged} duplicate row(s) retired, ${keepers.length} identity row(s) scanned`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
