/**
 * Discover NEW brands by analyzing patterns in unbranded products.
 *
 * Strategy:
 *   - For products without brand, find repeated "candidate words" in names
 *   - Words appearing frequently across many products are likely brand names
 *   - Common Persian words (شامپو، روغن، کیک) are filtered out
 *
 * Output: new-brands-candidates.json with ranked candidate brands
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = "/home/z/imach-back/local-data";
const PRODUCTS_DIR = path.join(DATA_DIR, "products-all");

function normalizeFa(text) {
  if (!text) return "";
  return text
    .replace(/[\u06F0-\u06F9]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x06F0 + 0x0030))
    .replace(/[\u0660-\u0669]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x0660 + 0x0030))
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/أ|إ|آ/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ی")
    .replace(/\u200c/g, " ")
    .toLowerCase()
    .trim();
}

function tokenize(text) {
  return normalizeFa(text)
    .replace(/[.,;:()؟!'"«»\-_/\\0-9]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 0);
}

// Persian stopwords / generic product words (not brand names)
const STOPWORDS = new Set([
  // Generic product types
  "شامپو", "روغن", "کیک", "نان", "شیر", "ماست", "پنیر", "کره", "قند", "شکر",
  "چای", "قهوه", "آب", "نوشیدنی", "نوشابه", "آبمیوه", "آبمیوه‌گیری", "آبمیوه‌گیری",
  "کنسرو", "کالباس", "سوسیس", "همبرگر", "کباب", "خورش", "سوپ", "آش",
  "دسر", "شیرینی", "بیسکویت", "کلوچه", "وافل", "تنقلات", "چیپس", "پفک",
  "پاستیل", "آدامس", "تنباکو", "سیگار", "نیشکر",
  "صابون", "مایع", "پودر", "قرص", "کپسول",
  "خمیر", "رنگ", "سیمان", "گچ", "آهک", "آجر",
  "شوینده", "ظرفشویی", "لباسشویی", "سطوح", "بهداشتی", "تمیزکننده", "پاککننده", "پاک‌کننده", "پاک کن",
  "دستمال", "کاغذی", "پنبه", "دستکش",
  "خمیردندان", "خمیر", "دندان", "مسواک", "دهان‌شویه", "خوشبوکننده", "خوشبو",
  "کرم", "لوسیون", "اسپری", "فوم", "ژل", " بالم",
  "رژ", "رژلب", "رژگونه", "کرم‌پودر", "پودر", "خط‌چشم", "سایه",
  "شور", "نرمکننده", "نرم", "سفت", "خشک", "تازه",
  "خشکبار", "آجیل", "مغز", "بادام", "فندق", "پسته", "گردو", "بادام‌زمینی",
  "انار", "انبه", "هندوانه", "خربزه", "طالبی", "خیار", "گوجه",
  "سیب", "موز", "پرتقال", "لیمو", "نعنا", "دارچین", "زعفران", "زنجبیل",
  "نعناع", "نعنا", "هل", "فلفل", "نمک", "شکر",
  "گوشت", "مرغ", "ماهی", "تن", "تون",
  "برنج", "ماکارونی", "اسپاگتی", "رشته",
  "ادویه", "چاشنی", "سس", "رب", "ترشی", "شوری",
  "پروتئین", "کنسرو", "کف", "کف‌شو", "کفشو",
  // Product attributes / descriptors
  "خالص", "طبیعی", "ارگانیک", "سنتی", "مخصوص", "ساده", "خام", "پخته", "سرخ", "آبپز",
  "تصفیه", "نشده", "خالص", "درجه", "خانگی", "صنعتی",
  "تازه", "منجمد", "سرد", "گرم", "یخ", "خامه",
  "شکلاتی", "شکلات", "وانیلی", "نعنایی", "لیمویی", "پرتقالی", "سیبی",
  "اناری", "گیلاسی", "آلبالویی", "زردآلویی", "هلو", "انگوری", "انجیری",
  "خرمایی", "توت", "تمشک", "بلوبری", "پاپایا", "آناناس",
  "خشک", "تازه", "خام", "پخته", "سرخ", "آبپز",
  "خالص", "تصفیه‌شده", "تصفیه",
  "نرم", "سفت", "آهست", "تند", "مخلوط", "ترکیبی", "ویژه", "خوبه", "خوب", "عالی", "باکیفیت", "یکم",
  // Quantities
  "گرم", "گرمی", "کیلو", "کیلویی", "میلی", "لیتر", "لیتری", "عدد", "عددی",
  "پاکت", "بسته", "جعبه", "قوطی", "شیشه", "بشکه",
  "میلی‌لیتر", "میلیلیتر", "سی‌سی", "کیلوگرم", "کیسه", "کیسه‌ای", "بشکه",
  // Numbers
  "یک", "دو", "سه", "چهار", "پنج", "شش", "هفت", "هشت", "نه", "ده",
  "صد", "هزار", "اول", "دوم", "سوم",
  // Colors
  "سفید", "قرمز", "زرد", "سبز", "آبی", "مشکی", "قهوه‌ای", "نارنجی", "صورتی", "بنفش",
  // Sizes/qualities
  "بزرگ", "کوچک", "متوسط", "خانواده", "اقتصادی", "ویژه",
  // Origins
  "ایرانی", "خارجی", "فرانسوی", "آلمانی", "آمریکایی", "ترک", "چینی", "ژاپنی",
  "هندی", "ایتالیایی", "اسپانیایی", "انگلیسی", "روسی", "تایلندی", "مالزیایی", "خارجی",
  // Common adjectives/adverbs
  "با", "بدون", "حاوی", "نوع", "مدل", "سایز", "اندازه", "کد",
  "تولید", "شرکت", "محصول", "وارداتی", "داخلی", "نو",
  "بسته‌بندی", "استاندارد", "تأیید", "مشخصات", "فنی",
  "سفارش", "حرفه‌ای", "روشن", "تیره",
  "طعم", "مزه", "بو", "رنگ", "شکل", "حجم", "وزن", "ارتفاع", "طول", "عرض",
  "حالا", "بعد", "قبل", "زود", "دیر", "سریع", "کند", "زیاد", "کم",
  "بالا", "پایین", "وسط", "کنار", "روی", "زیر", "جلو", "عقب", "داخل", "خارج",
  // More generic words (specific to this dataset)
  "شکلات", "تخته", "ای", "پاستیل", "ویفر",
  "مرطوب", "کننده", "مرطوب‌کننده", "مرطوبکننده", "نرمکننده", "نرم‌کننده", "ضدتعریق", "ضد", "تعریق",
  "بستنی", "بستنی‌", "شیری", "شیرین", "عسل", "میوه", "دار", "مغز",
  "فرنگی", "گوجه", "رب",
  "مردانه", "زنانه", "کودک", "نوزاد",
  "پاک", "کننده", "پاککننده", "پاک‌کننده",
  "ضدشوره", "ضدریزش", "ضدآفتاب", "ضدباکتریال", "آنتی", "باکتریال",
  "بهداشت", "بهداشتی", "مراقبت", "مو",
  "خشک", "آسیب", "دیده",
  "های", "ها", "هایی", "هایی‌",
  "میوه‌ای", "میوهای", "کیسه‌ای", "کیسه‌ای",
  "کادویی", "کادو",
  "انرژی", "زا", "انرژی‌زا", "انرژیزا", "گازدار",
  "کافی", "میکس", "میکس", "کافه", "کافیمیکس",
  "دو", "در", "یک",
  "تلخ", "شیرین", "شکلاتی",
  "اضافه", "افزوده", "افزودنی", "خوراکی",
  "سفیدکننده", "سفید", "رنگی", "رنگ",
  "شوینده", "مایع",
  "کرم", "دست", "صورت", "بدن", "آفتاب",
  "آلوئه", "ورا", "الویه", "الو",
  "خوبه", "خوب", "عالی", "باکیفیت",
  "کننده", "کننده", "کننده",
  "نسخه", "جدید", "قدیمی",
  "پرفروش", "پرفروش",
  "همراه", "همراه‌", " free", "آزاد",
  "اسپی", "آسپی", "استیک", "استیکی",
  "اورال", "بی", "اورال‌بی", "اورالبی",
  "ایستگام", "ایستام", "ایسترم", "ایستا", "استگاه",
  "کیلویی", "گرمی",
  "خام", "پخته",
  "خالص", "طبیعی",
  "خاص", "ویژه",
  "دوست", "دوستانه",
  "مخلوط", "ترکیبی", "مخلوطی",
  "نازک", "نازک",
  "ضخیم", "کلفت",
  "برگ", "برگی",
  "رنگ", "رنگی",
  "چاپ", "چاپی",
  "ساده", "ساد",
  "طرحدار", "طرح",
  "فلزی", "پلاستیکی", "شیشه‌ای", "کاغذی", "چرمی", "چوبی", "پارچه‌ای",
  "آستر", "آستردار",
  "دکمه", "زیپ", "کش",
  "بلند", "کوتاه", "میان", "مچ",
  "تاب", "تابه", "تابه‌",
  "کلین", "کلینر", "پاککننده", "پاک‌کننده", "پاککننده",
  "فرشی", "فرش", "فرش‌شویی",
  "خشک", "تار",
  "ترد", "تردکننده",
  "خشک", "نم", "نمدار",
  "نرم", "نرم‌کننده", "نرمکننده",
  "ضدآب", "ضدآب",
  "ضدلک", "ضدلک",
  "ضدچروک", "ضدچروک",
  "ضدباکتری", "ضدباکتری",
  "ضدجمع", "ضدجمع",
  "ضدلغزش", "ضدلغزش",
  "ضداشعه", "ضداشعه",
  "باردار", "بارداری",
  "نوزاد", "نوزادی",
  "کودک", "کودکان",
  "بزرگسال", "بزرگسالان",
  "خانم", "آقای", "مردانه", "زنانه",
  "خانواده", "خانوادگی",
  "اقتصادی", "لوکس", "ویژه",
  "سفارشی", "سفارش",
  "صنعتی", "خانگی",
  "سنتی", "مدرن",
  "طبیعی", "مصنوعی",
  "ارگانیک", "غیرارگانیک",
  "گیاهی", "حیوانی",
  "تقلبی", "اصل",
  "درجه", "یکم", "دوم",
  "نو", "کارکرده",
  "تازه", "کهنه",
  "خام", "پخته",
  "تصفیه", "نشده",
  "خالص", "ناخالص",
  "ساده", "مرکب",
  "سفید", "رنگی",
  "شفاف", "مات",
  "براق", "براق",
  "مخمل", "مخملی",
  "ابریشم", "ابریشمی",
  "نخی", "پنبه‌ای",
  "نایلونی", "پلاستیکی",
  "چرمی", "چرم",
  "چوبی", "چوب",
  "فلزی", "فلز",
  "شیشه‌ای", "شیشه",
  "کاغذی", "کاغذ",
  "آجری", "آجر",
  "سیمانی", "سیمان",
  "گچی", "گچ",
  "سنگی", "سنگ",
  "بتنی", "بتن",
  "استیل", "استیل",
  "آلومینیومی", "آلومینیوم",
  "مسی", "مس",
  "برنجی", "برنج",
  "طلایی", "طلا",
  "نقره‌ای", "نقره",
  "رویی", "روی",
  "سربی", "سرب",
  "آهنی", "آهن",
  "فولادی", "فولاد",
  "استیل",
  // Common foreign/Latin words
  "free", "fresh", "ultra", "extra", "pro", "max", "plus", "mini", "super",
  "natural", "organic", "classic", "soft", "hard", "light", "dark", "white",
  "black", "red", "green", "blue", "yellow", "pink", "gold", "silver",
  "king", "queen", "best", "top", "first", "one", "two", "three",
]);

function main() {
  console.log("=== Loading data ===");
  const brands = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "brands.json"), 'utf8')).brands;
  const knownBrands = new Set(brands.map(b => normalizeFa(b.name)));
  console.log(`Known brands: ${brands.length}`);

  // Read all products
  const files = fs.readdirSync(PRODUCTS_DIR).filter(f => /^page-\d+\.json$/.test(f));
  const allProducts = new Map();
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(PRODUCTS_DIR, f), 'utf8'));
    for (const item of data.items) {
      if (!allProducts.has(item.id)) allProducts.set(item.id, item);
    }
  }
  console.log(`Unique products: ${allProducts.size}`);

  // Collect word frequencies from unbranded products
  const wordFreq = new Map();     // word → count
  const wordSamples = new Map();   // word → [sample product names]
  const phrase2Freq = new Map();   // 2-word phrase → count
  const phrase2Samples = new Map();

  let unbrandedCount = 0;
  for (const item of allProducts.values()) {
    if (item.brand && item.brand.name) continue;
    unbrandedCount++;

    const tokens = tokenize(item.name_fa || "");
    if (tokens.length === 0) continue;

    // Single-word candidates
    for (const t of tokens) {
      if (STOPWORDS.has(t)) continue;
      if (knownBrands.has(t)) continue;
      if (t.length < 3) continue;
      // Skip pure digits
      if (/^\d+$/.test(t)) continue;
      // Skip very common Persian patterns (just digits + suffix)
      if (/^\d+(گرم|گری|کیلو|میلی|لیتر|عدد)$/.test(t)) continue;

      wordFreq.set(t, (wordFreq.get(t) || 0) + 1);
      if (!wordSamples.has(t)) wordSamples.set(t, []);
      const samples = wordSamples.get(t);
      if (samples.length < 3) samples.push(item.name_fa);
    }

    // 2-word phrase candidates (for brands like "هد اند شولدرز")
    for (let i = 0; i < tokens.length - 1; i++) {
      const w1 = tokens[i], w2 = tokens[i + 1];
      if (STOPWORDS.has(w1) || STOPWORDS.has(w2)) continue;
      if (w1.length < 2 || w2.length < 2) continue;
      if (/^\d+$/.test(w1) || /^\d+$/.test(w2)) continue;
      const phrase = `${w1} ${w2}`;
      phrase2Freq.set(phrase, (phrase2Freq.get(phrase) || 0) + 1);
      if (!phrase2Samples.has(phrase)) phrase2Samples.set(phrase, []);
      const samples = phrase2Samples.get(phrase);
      if (samples.length < 3) samples.push(item.name_fa);
    }
  }

  console.log(`Unbranded products: ${unbrandedCount}`);
  console.log(`Unique single-word candidates: ${wordFreq.size}`);
  console.log(`Unique 2-word phrases: ${phrase2Freq.size}`);

  // Filter: only words appearing in ≥3 different products
  const minCount = 3;
  const singleCandidates = [];
  for (const [word, count] of wordFreq.entries()) {
    if (count >= minCount) {
      singleCandidates.push({ word, count, samples: wordSamples.get(word) });
    }
  }
  singleCandidates.sort((a, b) => b.count - a.count);

  const phraseCandidates = [];
  for (const [phrase, count] of phrase2Freq.entries()) {
    if (count >= minCount) {
      phraseCandidates.push({ phrase, count, samples: phrase2Samples.get(phrase) });
    }
  }
  phraseCandidates.sort((a, b) => b.count - a.count);

  // Save results
  const result = {
    generated_at: new Date().toISOString(),
    total_unbranded: unbrandedCount,
    single_word_candidates: singleCandidates.slice(0, 100),
    two_word_phrase_candidates: phraseCandidates.slice(0, 100),
  };
  fs.writeFileSync(
    path.join(DATA_DIR, "new-brands-candidates.json"),
    JSON.stringify(result, null, 2)
  );

  console.log("\n=== Top 30 single-word brand candidates ===");
  for (const c of singleCandidates.slice(0, 30)) {
    console.log(`  ${c.word}: ${c.count} times (e.g., "${c.samples[0]}")`);
  }
  console.log("\n=== Top 20 two-word phrase brand candidates ===");
  for (const c of phraseCandidates.slice(0, 20)) {
    console.log(`  "${c.phrase}": ${c.count} times (e.g., "${c.samples[0]}")`);
  }
}

main();
