/*
 * Phase 7 E2E test — دایرکتوری تأمین‌کنندگان + پیشنهادها (طرح ۱۰/۱۱)
 * ۱) دموی واقعی (989196421264): getSuppliersDirectory (دو تب + برچسب‌ها) + getSuggestions (سه کارت)
 * ۲) کاربر موقت (quickRegister): فالو → واچ → پیشنهادها → واچِ جایگزین → جایگزین باید حذف شود
 * ۳) کش: MISS → HIT (x-cache)
 * ۴) پاک‌سازی کامل کاربر موقت
 */
require("dotenv").config();
if (process.env.MONGO_URL) process.env.DATABASE_URL = process.env.MONGO_URL;
const BASE = "http://127.0.0.1:4000/api/v1";
const DEMO_LOGIN = { phone: "989196421264", password: "123456" };
const TEMP_PHONE = "989120000097";

async function j(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text), cache: res.headers.get("x-cache") };
  } catch {
    return { status: res.status, data: text, cache: res.headers.get("x-cache") };
  }
}

const ok = (cond, label) => {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) process.exitCode = 1;
};

async function main() {
  // ── ۱) دموی واقعی ──
  const login = await j("POST", "/auth/loginUser", DEMO_LOGIN);
  const token = login.data.accessToken;
  ok(login.status === 200, "login demo 200");
  const demoBiz = (await j("GET", "/businesses/getMyBusinesses", null, token)).data[0];

  const dir = await j("GET", `/market/getSuppliersDirectory?businessId=${demoBiz.id}`, null, token);
  ok(dir.status === 200, `getSuppliersDirectory 200 (got ${dir.status})`);
  const related = dir.data.related ?? [];
  const followed = dir.data.followed ?? [];
  ok(related.length >= 4, `related ≥۴ فروشنده (got ${related.length})`);
  // ≥۴: چهار فالویِ seed همیشه هست؛ فالوی اضافی = فعالیت واقعی کاربر (دمو)
  // روی محیط زنده — تست نباید با فالوی مشروع کاربر شکست بخورد
  ok(followed.length >= 4, `followed ≥۴ (انزلی/سعید/سپید mine + کیان theirs) — got ${followed.length}`);

  const gilrangRel = related.find((r) => r.name === "تجارت گیل‌رنج");
  ok(!!gilrangRel, "گیل‌رنج در related");
  ok(
    !!gilrangRel && gilrangRel.goods.some((g) => g.nameFa === "برنج هاشمی") && gilrangRel.priceCount >= 1,
    "گیل‌رنج: چیپ «برنج هاشمی» + شمارش قیمت"
  );
  const kianFollowed = followed.find((f) => f.name === "کیان غلات");
  ok(!!kianFollowed && kianFollowed.origin === "theirs", "کیان: «خودش آمد» (theirs)");
  ok(
    !!kianFollowed && kianFollowed.goods.some((g) => g.nameFa === "برنج هاشمی"),
    "کیان: چیپ «برنج هاشمی» (کالای مرتبط من)"
  );
  const neginRel = related.find((r) => r.name.includes("نگین"));
  ok(!!neginRel && neginRel.boughtFrom === true, "نگین: «از او خریده‌ام» (استعلام ANSWERED)");
  const anzaliFollowed = followed.find((f) => f.name.includes("انزلی"));
  ok(!!anzaliFollowed && anzaliFollowed.origin === "mine", "انزلی در followed (mine)");
  ok(
    followed.every((f) => f.priceCount !== undefined && Array.isArray(f.goods)),
    "همه‌ی ردیف‌های followed: goods + priceCount"
  );

  const sugg = await j("GET", `/market/getSuggestions?businessId=${demoBiz.id}`, null, token);
  ok(sugg.status === 200, `getSuggestions 200 (got ${sugg.status})`);
  const bp = sugg.data.betterPrices ?? [];
  const ns = sugg.data.newSuppliers ?? [];
  const alt = sugg.data.alternatives ?? [];
  // دنیای دیتای فاز ۹ (زنجیره‌ی برنج): شبکه‌ی دموی پارس خودش ارزان‌ترین است
  // (بنکدار ۲۶.۸M در شبکه است) → کارت «قیمت بهتر» ممکن است خالی باشد؛
  // هر کارتی که بیاید باید per-base با boardBest مقایسه شده و ارزان‌تر باشد.
  ok(
    bp.every((b) => b.priceMinor < b.boardBestMinor && b.pct > 0),
    `قیمت بهتر: هر کارت واقعاً ارزان‌تر (got ${JSON.stringify(bp.map((b) => ({ n: b.supplier.name, p: b.priceMinor, best: b.boardBestMinor })))})`
  );
  // «تأمین‌کننده جدید» — خارج از شبکه/سابقه؛ در دنیای برنج گیل‌رنج score=98 هم‌شهری
  ok(
    ns.length >= 1,
    `تأمین‌کننده جدید: حداقل یک کارت خارج از شبکه (got ${ns.length})`
  );
  if (ns.length > 0) {
    ok(
      ns[0].supplier.name === "تجارت گیل‌رنج" && ns[0].goodName === "برنج هاشمی" && ns[0].score >= 90,
      `تأمین‌کننده جدید: گیل‌رنج / برنج هاشمی / score=${ns[0].score} / proximity=${ns[0].proximity}`
    );
  }
  // «جایگزین» — هم‌دسته هم‌واحدِ ارزان‌تر از کالای دنبال‌شده (فاز ۹: فجر از بنکدار)
  ok(
    alt.length >= 1 && alt[0].priceMinor < (alt[0].watchedPriceMinor ?? Infinity),
    `جایگزین: هم‌دسته‌ی ارزان‌تر برای «${alt[0] ? alt[0].watchedGoodName : "—"}» (got ${alt[0] && alt[0].goodName})`
  );

  // کش — فراخوانی دوم باید HIT باشد
  const sugg2 = await j("GET", `/market/getSuggestions?businessId=${demoBiz.id}`, null, token);
  ok(sugg2.cache === "HIT", `cache HIT on second call (got ${sugg2.cache})`);

  // ── ۲) کاربر موقت — جریان واقعی از صفر ──
  const reg = await j("POST", "/auth/quickRegister", { phone: TEMP_PHONE, country: "98" });
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`quickRegister failed: ${JSON.stringify(reg.data).slice(0, 200)}`);
  const tempToken = reg.data.accessToken ?? reg.data.session?.accessToken;
  const tempBiz = (await j("GET", "/businesses/getMyBusinesses", null, tempToken)).data[0];
  console.log(`temp biz: ${tempBiz.name}`);

  const goods = (await j("GET", `/goods/getGoods?q=${encodeURIComponent("برنج هاشمی")}&limit=5`, null, tempToken)).data;
  const hashemi = (goods.items ?? goods)[0];

  // برای کاربر تازه: اول واچ (سوخت موتور) بعد دایرکتوری (پیدا کردن انزلی)
  await j("POST", "/market/watchGood", { businessId: tempBiz.id, goodId: hashemi.id }, tempToken);
  const dirTemp = await j("GET", `/market/getSuppliersDirectory?businessId=${tempBiz.id}`, null, tempToken);
  const anzaliId = (dirTemp.data.related ?? []).find((r) => r.name.includes("انزلی"))?.supplierId;
  ok(!!anzaliId, "کاربر تازه (بعد از واچ): انزلی در «مرتبط با من»");
  await j("POST", "/market/followSupplier", { businessId: tempBiz.id, supplierId: anzaliId }, tempToken);

  const suggTemp = await j("GET", `/market/getSuggestions?businessId=${tempBiz.id}`, null, tempToken);
  // دنیای فاز ۹: کارت قیمتِ بهتر برای کاربر تازه = بنکدار ۲۶.۸M در برابر بهترینِ
  // شبکه‌اش (انزلی ۲۸.۵M) — چک عمومی: هر کارتِ بهتر واقعاً زیر boardBest باشد
  // و بسته‌ی ۱۰کیلوییِ پارس (۵.۹۵M) per-base قیف نشود (boardBest باید ۲۸.۵M بماند)
  const bpTemp = (suggTemp.data.betterPrices ?? [])[0];
  ok(
    !!bpTemp && bpTemp.priceMinor < bpTemp.boardBestMinor && bpTemp.boardBestMinor === 28_500_000,
    `کاربر تازه: قیمت بهتر ${bpTemp ? bpTemp.supplier.name + " " + bpTemp.priceMinor : "—"} ▼ از انزلی ۲٬۸۵۰٬۰۰۰ (boardBest=${bpTemp ? bpTemp.boardBestMinor : "—"} — per-base: بسته ۱۰کیلوییِ پخش برنج پارس نباید قیف شود)`
  );
  ok((suggTemp.data.alternatives ?? []).length >= 1, "کاربر تازه: کارت جایگزین (فجر یا طارم — واقعی)");
  const firstAlt = (suggTemp.data.alternatives ?? [])[0];

  // واچِ همان جایگزین → باید از کارت‌ها حذف شود (اینوالیدیشن)
  await j("POST", "/market/watchGood", { businessId: tempBiz.id, goodId: firstAlt.goodId }, tempToken);
  const suggTemp2 = await j("GET", `/market/getSuggestions?businessId=${tempBiz.id}`, null, tempToken);
  const altGone = !((suggTemp2.data.alternatives ?? []).some((a) => a.goodId === firstAlt.goodId));
  ok(altGone, `بعد از واچِ «${firstAlt.goodName}»، جایگزینِ همان کالا حذف شد`);

  const dirTemp2 = await j("GET", `/market/getSuppliersDirectory?businessId=${tempBiz.id}`, null, tempToken);
  ok((dirTemp2.data.followed ?? []).some((f) => f.name.includes("انزلی")), "کاربر تازه: انزلی در «دنبال‌شده»");
  ok(
    (dirTemp2.data.related ?? []).some((r) => r.name === "تجارت گیل‌رنج"),
    "کاربر تازه: گیل‌رنج در «مرتبط با من»"
  );

  // ── ۳) پاک‌سازی کامل کاربر موقت ──
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const tempUser = await prisma.user.findFirst({ where: { phone: TEMP_PHONE }, select: { id: true } });
    if (tempUser) await prisma.notification.deleteMany({ where: { userId: tempUser.id } });
    await prisma.watchedGood.deleteMany({ where: { businessId: tempBiz.id } });
    await prisma.follow.deleteMany({
      where: { OR: [{ followerPage: { businessId: tempBiz.id } }, { supplierPage: { businessId: tempBiz.id } }] },
    });
    await prisma.page.deleteMany({ where: { businessId: tempBiz.id } });
    await prisma.listing.deleteMany({ where: { businessId: tempBiz.id } });
    await prisma.business.delete({ where: { id: tempBiz.id } });
    if (tempUser) await prisma.user.delete({ where: { id: tempUser.id } });
    console.log("  cleanup: temp business + user removed");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("TEST FAILED:", e.message);
  process.exit(1);
});
