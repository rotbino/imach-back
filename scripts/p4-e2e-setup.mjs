// فاز ۴ E2E — آماده‌سازی دو کاربر تست بدون رمز (خریدار + فروشنده با آگهی فروش برنج هاشمی)
// اجرا: node scripts/p4-e2e-setup.mjs
import { writeFileSync } from "node:fs";

const BASE = "http://localhost:4000/api/v1";
const HASHEMI_GOOD_ID = "6abe2511578b46707877ed0f"; // برنج هاشمی

async function call(method, path, { body, token, cookies } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, json, setCookie };
}

async function setupUser(phone, { name, trade, city, arms }) {
  // ۱) quickRegister — بدون رمز (ورود مرورگر با همین یک مرحله)
  const reg = await call("POST", "/auth/quickRegister", { body: { phone, country: "IR" } });
  if (reg.status !== 201 && reg.status !== 200) throw new Error(`quickRegister ${phone}: ${reg.status} ${JSON.stringify(reg.json)}`);
  const token = reg.json.accessToken;
  const biz = reg.json.businesses?.[0];
  if (!biz) throw new Error(`no business for ${phone}`);
  // ۲) هویت کسب‌وکار
  const edit = await call("PATCH", `/businesses/editBusiness/${biz.id}`, {
    token,
    body: { name, city, trade },
  });
  if (edit.status >= 300) throw new Error(`editBusiness ${phone}: ${edit.status}`);
  // ۳) بازوها
  const armsRes = await call("PUT", `/businesses/setArms/${biz.id}`, { token, body: arms });
  if (armsRes.status >= 300) throw new Error(`setArms ${phone}: ${armsRes.status}`);
  return { phone, token, bizId: biz.id, bizName: name };
}

const seller = await setupUser("989100000447", {
  name: "پخش برنج تست فاز ۴",
  trade: "WHOLESALER",
  city: "همدان",
  arms: { sell: true, buy: false },
});

// آگهی فروش برنج هاشمی (برای ظاهر شدن در تابلوی تأمین خریدار)
const listing = await call("PUT", "/listings/saveListing", {
  token: seller.token,
  body: {
    businessId: seller.bizId,
    goodId: HASHEMI_GOOD_ID,
    mode: "SELL",
    sell: { priceMinor: 890000000 / 10, stock: 5000, minOrder: 100 },
  },
});
if (listing.status >= 300) throw new Error(`saveListing: ${listing.status} ${JSON.stringify(listing.json)}`);

const buyer = await setupUser("989100000441", {
  name: "رستوران تست فاز ۴",
  trade: "BUSINESS_CONSUMER",
  city: "همدان",
  arms: { sell: false, buy: true },
});

const out = { seller: { phone: seller.phone, bizId: seller.bizId }, buyer: { phone: buyer.phone, bizId: buyer.bizId }, goodId: HASHEMI_GOOD_ID };
writeFileSync("/home/z/my-project/tool-results/p4-e2e-users.json", JSON.stringify(out, null, 2));
console.log("SELLER:", seller.phone, seller.bizName);
console.log("BUYER :", buyer.phone, buyer.bizName);
console.log("LISTING:", listing.json?.id ?? "(existing)");
console.log("OK — users ready");
