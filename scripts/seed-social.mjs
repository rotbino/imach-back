#!/usr/bin/env node
/**
 * iMach — M10 seed: VideoLesson + Testimonial (سند ۰۳ §۵ گام ۳)
 * ------------------------------------------------------------
 * منبع محتوا: TS_DATA پروتوتایپ redesign-base (۱۰ نظر مالک) برای
 * Testimonial و ساختار راهنمای دستیارها (۶۰/۶۱) برای VideoLesson.
 * پوسترها = اسکرین‌شات‌های عمومی خودِ اپ (/screenshots) — بارگذاری
 * ویدیوی واقعی «فاز محتوایی» است نه فاز داده (سند ۰۳ §۴.۶).
 *
 * Idempotent: ردیف تکراری (arm+title / name+text) skip می‌شود.
 * Usage: node scripts/seed-social.mjs [--uri mongodb://…]
 */
import { MongoClient } from "mongodb";

const uri = process.argv.find((a) => !a.startsWith("--") && a.includes("mongo")) ?? process.env.DATABASE_URL;
if (!uri) {
  console.error("usage: node scripts/seed-social.mjs [--uri mongodb://…]");
  process.exit(1);
}

/// ۱۰ نظر ویترین — عین TS_DATA پروتوتایپ (۶ نوار لندینگ + ۴ صفحهٔ سایر نظرات)
const TESTIMONIALS = [
  { name: "علی محمدی", business: "پخش لوازم خودرو", role: "sell", feature: "کاتالوگ با قیمت همیشه به‌روز", when: "۳ روز پیش",
    text: "با ساخت کاتالوگ محصولات و ارسال لینک اون به خریداران همکار، دیگه دغدغه ارسال قیمت هر روزه به همکارانم رو ندارم. یک‌بار قیمت‌ها رو به‌روز می‌کنم و همه می‌بینن." },
  { name: "صادق اکبری", business: "ویزیتور مواد غذایی", role: "sell", feature: "سفارش بدون حضور در محل", when: "۱ هفتهٔ پیش",
    text: "با ساخت کاتالوگ محصولاتم و ارسال اون به سوپرمارکت‌ها، حالا حتی بدون حضور در محل هم می‌تونم سفارش‌های جدید بگیرم. ممنون از آیمچ!" },
  { name: "مهدی رضایی", business: "خریدار عمده مواد اولیه", role: "buy", feature: "مقایسهٔ قیمت تأمین‌کنندگان", when: "۲ هفتهٔ پیش",
    text: "قبلاً برای پیدا کردن فروشنده و گرفتن قیمت باید با چند نفر تماس می‌گرفتم. حالا می‌تونم قیمت تأمین‌کننده‌های مختلف رو کنار هم دنبال کنم و راحت‌تر مقایسه کنم." },
  { name: "رضا کریمی", business: "تولیدکننده محصولات شوینده", role: "sell", feature: "معرفی محصولات به مشتریان", when: "۳ هفتهٔ پیش",
    text: "با کاتالوگ آیمچ، محصولاتم رو یک‌جا به مشتریان معرفی می‌کنم و هر وقت محصول یا قیمت جدیدی داشته باشم، کاتالوگم رو به‌روز می‌کنم." },
  { name: "حسین مرادی", business: "عمده‌فروش لوازم ساختمانی", role: "sell", feature: "دنبال‌کردن درخواست‌های خرید", when: "۱ ماه پیش",
    text: "لازم نیست منتظر تماس مشتری بمونم تا بفهمم چه کالایی می‌خواد. با دنبال کردن درخواست‌های خرید مرتبط، می‌تونم زودتر از نیاز خریدارها باخبر بشم و قیمت بدم." },
  { name: "امیرحسین احمدی", business: "توزیع‌کننده محصولات کشاورزی", role: "sell", feature: "قیمت و موجودی به‌روز", when: "۱ ماه پیش",
    text: "قیمت و موجودی محصولات مدام تغییر می‌کنه. حالا می‌تونم اطلاعات کالاهای قابل عرضه‌ام رو در کاتالوگ به‌روز نگه دارم تا خریدارها قبل از تماس، اطلاعات بهتری داشته باشن." },
  { name: "مریم قاسمی", business: "سوپرمارکت قاصدک", role: "buy", feature: "گوش به زنگ قیمت", when: "۲ هفتهٔ پیش",
    text: "زنگولهٔ «گوش به زنگ» رو روی برنج و روغن روشن می‌کنم و قیمت هدف می‌دم؛ همون‌طور که قیمت به هدفم رسید پیام اومد. دیگه هر روز چند بار کاتالوگ‌ها رو چک نمی‌کنم." },
  { name: "کریم دهقان", business: "پخش لبنیات مهرگان", role: "sell", feature: "درخواست‌های خرید مرتبط", when: "۳ هفتهٔ پیش",
    text: "به‌جای اینکه منتظر بمونم مشتری زنگ بزنه، درخواست‌های خرید مرتبط با لبنیات رو می‌بینم و همون روز براشون قیمت می‌دم. فروش هفتگی‌ام منظم‌تر شده." },
  { name: "الهام صادقی", business: "رستوران خانهٔ سبز", role: "buy", feature: "یک فرم به چند تأمین‌کننده", when: "۱ ماه پیش",
    text: "یک فرم درخواست خرید می‌فرستم برای چند تأمین‌کننده با هم و مهلت سه‌روزه می‌ذارم؛ روز سوم بهترین قیمت و شرایط جلوی چشممه. بعد فقط تماس نهایی رو می‌گیرم." },
  { name: "بهرام نیک‌پور", business: "تولیدکننده زعفران و خشکبار", role: "sell", feature: "تبلیغ هدفمند کم‌هزینه", when: "۱ ماه پیش",
    text: "با تبلیغ هدفمند، کالای من دقیقاً جلوی چشم خریدارِ همون کالا می‌ره — نه همه‌جا. هزینه‌ش هم فقط وقتی از کیف پول کم می‌شه که واقعاً دیده بشم." },
];

/// فیلم‌های آموزشی راهنماها — ساختار محتوایی از ۶۰/۶۱؛ پوستر = اسکرین‌شات اپ
const LESSONS = [
  { arm: "BUY", title: "لیست خریدت را بساز", durationS: 134, posterUrl: "/screenshots/08-buy-list.png", sortHint: 10,
    bullets: ["کالاهای عمدهٔ خودت را با حجم و دورهٔ خرید اضافه کن", "قیمت هر کالا خودکار دنبال می‌شود", "یادآور اتمام موجودی پیش از تمام‌شدن"] },
  { arm: "BUY", title: "تابلوی تأمین هر کالا", durationS: 168, posterUrl: "/screenshots/09-supply-board.png", sortHint: 20,
    bullets: ["تأمین‌کنندگان هر کالا یک‌جا", "مرتب بر اساس نزدیکی و اعتبار", "فروشندهٔ ویژه‌ها بالاتر دیده می‌شوند"] },
  { arm: "BUY", title: "استعلام قیمت رقابتی", durationS: 185, posterUrl: "/screenshots/11-suggestions.png", sortHint: 30,
    bullets: ["یک فرم به چند تأمین‌کننده با هم", "مهلت پاسخ ۱ تا ۵ روز", "پیشنهادها کنار هم مقایسه می‌شوند"] },
  { arm: "SELL", title: "کاتالوکت را بساز", durationS: 150, posterUrl: "/screenshots/01-sell-catalog.png", sortHint: 10,
    bullets: ["قیمت و موجودی هر کالا با بسته‌بندی و برند", "اعتبار قیمت ۱ تا ۵ روز", "به‌روزرسانی گروهی برای کاتالوگ بزرگ"] },
  { arm: "SELL", title: "درخواست‌های خرید را جواب بده", durationS: 142, posterUrl: "/screenshots/05-sell-requests.png", sortHint: 20,
    bullets: ["استعلام‌های رسیده با مهلت و شمار قلم", "قیمت هر قلم + شرایط پرداخت و تحویل", "پاسخ جزئی فقط برای اقلام خودت"] },
  { arm: "SELL", title: "کاتالوگ عمومی‌ات را ببین", durationS: 120, posterUrl: "/screenshots/13-catalog-public.png", sortHint: 30,
    bullets: ["همان‌طور که خریدار می‌بیند", "لینک و QR برای اشتراک با مشتریان", "هر تغییر قیمت همان لحظه دیده می‌شود"] },
];

const ROLE_LABEL = { sell: "فروشنده عمده", buy: "خریدار عمده" };

const client = new MongoClient(uri);
await client.connect();
const db = client.db();

// ── VideoLesson ──
const vl = db.collection("VideoLesson");
let vlNew = 0;
for (const l of LESSONS) {
  const exists = await vl.findOne({ arm: l.arm, title: l.title });
  if (exists) continue;
  await vl.insertOne({ ...l, isActive: true });
  vlNew++;
}
console.log(`VideoLesson: +${vlNew} (total ${await vl.countDocuments({})})`);

// ── Testimonial ──
const ts = db.collection("Testimonial");
let tsNew = 0;
let sortHint = TESTIMONIALS.length * 10;
for (const t of TESTIMONIALS) {
  const exists = await ts.findOne({ name: t.name, text: t.text });
  if (exists) continue;
  await ts.insertOne({
    name: t.name,
    business: t.business,
    role: ROLE_LABEL[t.role] ?? "فروشنده عمده",
    isBuyer: t.role === "buy",
    feature: t.feature,
    text: t.text,
    approved: true,
    sortHint,
    createdAt: new Date(),
  });
  sortHint -= 10;
  tsNew++;
}
console.log(`Testimonial: +${tsNew} approved (total ${await ts.countDocuments({})})`);

await client.close();
console.log("seed-social done ✔");
