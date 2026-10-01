// شبیه‌سازی دقیق کوئری‌های Prisma که /admin/categories/tree و /admin/goods/list اجرا می‌کنند
// اگر هر کدام throw کند ← همان خطای 500 که کالاها را لود نمی‌کند
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ log: ['error'] });

(async () => {
  console.log('── تست ۱: category.findMany (همان select کنترلر tree، شامل parentId)...');
  try {
    const cats = await prisma.category.findMany({
      select: { id: true, slug: true, nameFa: true, nameEn: true, gs1GpcCode: true, hsCode: true, unit: true, attrs: true, parentId: true },
      orderBy: { id: 'asc' },
    });
    console.log(`✅ OK — ${cats.length} دسته خوانده شد`);
    // شبیه‌سازی ساخت درخت مثل کنترلر
    const byId = new Map(cats.map(c => [c.id, c]));
    let roots = 0, dropped = 0;
    for (const c of cats) {
      const parent = c.parentId ? byId.get(c.parentId) : undefined;
      if (c.parentId && !parent) dropped++;
      if (!c.parentId) roots++;
    }
    console.log(`   ریشه‌ها: ${roots} | دسته‌های یتیم/ریک‌شده: ${dropped}`);
  } catch (e) {
    console.log(`❌ FAIL: ${e.message.split('\n').slice(0, 6).join(' | ')}`);
  }

  console.log('\n── تست ۲: good.groupBy categoryId (شمارش کالاها در درخت)...');
  try {
    const counts = await prisma.good.groupBy({ by: ['categoryId'], _count: { _all: true } });
    console.log(`✅ OK — ${counts.length} گروه، مجموع: ${counts.reduce((s, c) => s + c._count._all, 0)}`);
  } catch (e) {
    console.log(`❌ FAIL: ${e.message.split('\n').slice(0, 6).join(' | ')}`);
  }

  console.log('\n── تست ۳: good.findMany با relation category (صفحه /admin/goods/list بدون فیلتر)...');
  try {
    const rows = await prisma.good.findMany({
      select: {
        id: true, nameFa: true, nameEn: true, aliases: true, unit: true, source: true, status: true, creatorRole: true,
        createdBy: { select: { id: true, name: true } },
        category: { select: { id: true, slug: true, nameFa: true, nameEn: true } },
        _count: { select: { listings: true } },
      },
      orderBy: { id: 'desc' },
      take: 31,
    });
    const noCat = rows.filter(r => !r.category).length;
    console.log(`✅ OK — ${rows.length} ردیف${noCat ? ` (⚠️ ${noCat} ردیف category=null!)` : ''}`);
  } catch (e) {
    console.log(`❌ FAIL: ${e.message.split('\n').slice(0, 6).join(' | ')}`);
  }

  console.log('\n── تست ۴: /admin/goods/list با categoryId=textile root (شبیه کلیک روی درخت)...');
  try {
    const textile = await prisma.category.findFirst({ where: { slug: 'textile' }, select: { id: true } });
    const all = await prisma.category.findMany({ select: { id: true, parentId: true } });
    const kidsOf = new Map();
    for (const c of all) { if (!c.parentId) continue; (kidsOf.get(c.parentId) ?? kidsOf.set(c.parentId, []).get(c.parentId)).push(c.id); }
    const categoryIds = [textile.id]; const stack = [textile.id];
    while (stack.length) { const cur = stack.pop(); for (const kid of kidsOf.get(cur) ?? []) { categoryIds.push(kid); stack.push(kid); } }
    const rows = await prisma.good.findMany({
      where: { categoryId: { in: categoryIds } },
      select: { id: true, nameFa: true, category: { select: { nameFa: true } } },
      orderBy: { id: 'desc' }, take: 31,
    });
    console.log(`✅ OK — ${rows.length} کالای textile در صفحه اول`);
  } catch (e) {
    console.log(`❌ FAIL: ${e.message.split('\n').slice(0, 6).join(' | ')}`);
  }

  console.log('\n── تست ۵: category.findMany با isActive در select (getCategories عمومی)...');
  try {
    const rows = await prisma.category.findMany({
      select: { id: true, slug: true, nameFa: true, nameEn: true, gs1GpcCode: true, hsCode: true, attrs: true, unit: true, isActive: true, parentId: true },
    });
    const noActive = rows.filter(r => r.isActive === null || r.isActive === undefined).length;
    console.log(`✅ OK — ${rows.length} دسته${noActive ? ` (⚠️ ${noActive} دسته isActive=null/undefined)` : ''}`);
  } catch (e) {
    console.log(`❌ FAIL: ${e.message.split('\n').slice(0, 6).join(' | ')}`);
  }

  await prisma.$disconnect();
})().catch(e => { console.error('💥', e); process.exit(1); });
