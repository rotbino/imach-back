/*
 * Phase 9 e2e — enabledArms (شکاف ۶) + جریان ثبت‌نام دوگامی + ورود موبایل-اول
 * اجرا: node scripts/phase9-e2e.js  (بک‌اند باید روی :4000 روشن باشد)
 * پاک‌سازی کامل در پایان — هیچ ردی روی دیتای دمو نمی‌ماند.
 */
require("dotenv").config();
if (process.env.MONGO_URL) process.env.DATABASE_URL = process.env.MONGO_URL;
const BASE = "http://localhost:4000/api/v1";
let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  console.log(`${cond ? "✓" : "✗ FAIL"} ${name}`);
  cond ? pass++ : fail++;
};

async function login(phone, password = "123456") {
  const r = await fetch(`${BASE}/auth/loginUser`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password, country: "IR" }),
  });
  return { ok: r.ok, json: await r.json() };
}

async function main() {
  /* ═══ ۱) checkPhone — مبنای مسیر صفحه ورود (طرح ۱۷) ═══ */
  const cpExisting = await (await fetch(`${BASE}/auth/checkPhone`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "989196421264", country: "IR" }),
  })).json();
  ok("checkPhone: شماره‌ی ثبت‌شده با رمز → available=false + hasPassword=true",
    cpExisting.available === false && cpExisting.hasPassword === true);

  const cpFresh = await (await fetch(`${BASE}/auth/checkPhone`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "989123456789", country: "IR" }),
  })).json();
  ok("checkPhone: شماره‌ی تازه → available=true", cpFresh.available === true);

  /* ═══ ۲) ورود هر ۶ نقش زنجیره‌ی برنج با رمز 123456 ═══ */
  // نکته: throttle احراز‌هویت ۱۵/دقیقه — بین ورودها فاصله می‌اندازیم
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ROLES = [
    ["989196421264", "پخش برنج پارس", "both"],
    ["989111111111", "مزرعه برنج سراوان", "both"],
    ["989222222222", "بنکداری برنج گیل", "both"],
    ["989333333333", "رستوران دیوان", "both"],
    ["989444444444", "تالار مجلل نیایش", "buy-only"],
    ["989155555555", "هتل رستوران نفت", "buy-only"],
  ];
  const sessions = {};
  for (const [phone, name, expectArms] of ROLES) {
    const { ok: okReq, json } = await login(phone);
    const biz = (json.businesses ?? [])[0] ?? {};
    const arms = biz.enabledArms ?? null;
    const armsOk = expectArms === "both"
      ? arms === null || (arms?.sell !== false && arms?.buy !== false) // null یا هر دو روشن
      : arms?.sell === false && arms?.buy === true;
    ok(`ورود ${name} (${phone}) + arms=${expectArms}`, okReq && biz.name === name && armsOk);
    sessions[phone] = { token: json.accessToken, bizId: biz.id };
    if (!okReq) console.log("   ↳ login error:", JSON.stringify(json).slice(0, 120));
    await sleep(4500);
  }

  /* ═══ ۳) setArms — اعتبارسنجی «حداقل یکی روشن» ═══ */
  const pars = sessions["989196421264"];
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${pars.token}` };
  const bothOff = await fetch(`${BASE}/businesses/setArms/${pars.bizId}`, {
    method: "PUT", headers: H, body: JSON.stringify({ sell: false, buy: false }),
  });
  const bothOffBody = await bothOff.json();
  ok("setArms: هر-دو-خاموش → 400 ARMS_REQUIRED", bothOff.status === 400 && bothOffBody.error === "ARMS_REQUIRED");

  const off = await (await fetch(`${BASE}/businesses/setArms/${pars.bizId}`, {
    method: "PUT", headers: H, body: JSON.stringify({ sell: false }),
  })).json();
  ok("setArms: merge — فقط sell خاموش، buy دست‌نخورده", off.sell === false && off.buy === true);

  const talar = sessions["989444444444"];
  const nonOwner = await fetch(`${BASE}/businesses/setArms/${pars.bizId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${talar.token}` },
    body: JSON.stringify({ sell: true }),
  });
  ok("setArms: غیرمالک → 403", nonOwner.status === 403);

  // بازگرداندن وضعیت دمو
  const restored = await (await fetch(`${BASE}/businesses/setArms/${pars.bizId}`, {
    method: "PUT", headers: H, body: JSON.stringify({ sell: true }),
  })).json();
  ok("setArms: بازگردانی هر دو روشن", restored.sell === true && restored.buy === true);

  /* ═══ ۴) ثبت‌نام دوگامی — کاربر موقت (خودکار پاک می‌شود) ═══ */
  await sleep(4500);
  const TMP_PHONE = "989123000999";
  const reg = await (await fetch(`${BASE}/auth/quickRegister`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: TMP_PHONE, country: "IR" }),
  })).json();
  ok("گام ۱: quickRegister → سشن + بیزینس placeholder «کاتالوگ شما» city=—",
    !!reg.accessToken && reg.businesses[0]?.name === "کاتالوگ شما" && reg.businesses[0]?.city === "—");
  const TH = { "Content-Type": "application/json", Authorization: `Bearer ${reg.accessToken}` };
  const tmpBizId = reg.businesses[0].id;

  // گام ۲: نام + کسب‌وکار + نقش «می‌خرم»
  const profile = await fetch(`${BASE}/auth/editProfile`, {
    method: "POST", headers: TH, body: JSON.stringify({ firstName: "کاربر", lastName: "آزمون" }),
  });
  ok("گام ۲: editProfile نام شخص", profile.ok);
  const bizEdit = await fetch(`${BASE}/businesses/editBusiness/${tmpBizId}`, {
    method: "PATCH", headers: TH, body: JSON.stringify({ name: "آزمون کاتالوگ", city: "رشت", trade: "ابزار و یراق" }),
  });
  ok("گام ۲: editBusiness روی placeholder (نام/شهر/صنف)", bizEdit.ok);
  const armsSet = await (await fetch(`${BASE}/businesses/setArms/${tmpBizId}`, {
    method: "PUT", headers: TH, body: JSON.stringify({ sell: false, buy: true }),
  })).json();
  ok("گام ۲: نقش «می‌خرم» → enabledArms={sell:false,buy:true}",
    armsSet.sell === false && armsSet.buy === true);

  const me = await (await fetch(`${BASE}/auth/getMe`, { headers: { Authorization: `Bearer ${reg.accessToken}` } })).json();
  ok("getMe بعد از ثبت‌نام: enabledArms جاری می‌آید",
    me.businesses?.[0]?.enabledArms?.buy === true && me.businesses?.[0]?.enabledArms?.sell === false);

  /* ═══ ۵) پاک‌سازی کامل کاربر موقت + بازگردانی وضعیت دمو ═══ */
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  const tmpUser = await prisma.user.findUnique({ where: { phone: TMP_PHONE }, select: { id: true } });
  if (tmpUser) {
    await prisma.listing.deleteMany({ where: { businessId: tmpBizId } });
    await prisma.watchedGood.deleteMany({ where: { businessId: tmpBizId } });
    await prisma.page.deleteMany({ where: { businessId: tmpBizId } });
    await prisma.business.deleteMany({ where: { id: tmpBizId } });
    await prisma.refreshToken.deleteMany({ where: { userId: tmpUser.id } });
    await prisma.user.delete({ where: { id: tmpUser.id } });
  }
  const gone = await (await fetch(`${BASE}/auth/checkPhone`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: TMP_PHONE, country: "IR" }),
  })).json();
  ok("پاک‌سازی کامل کاربر موقت", gone.available === true);
  // بازگردانی وضعیت اولیه‌ی پارس (enabledArms=null = هر دو روشن)
  await prisma.business.update({ where: { id: pars.bizId }, data: { enabledArms: null } });
  await prisma.$disconnect();

  console.log(`\n═══ ${pass} passed · ${fail} failed ═══`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("E2E FAILED:", e);
  process.exit(1);
});
