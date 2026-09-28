/**
 * Extract brands v3 — improved brand extraction with extended brand list.
 *
 * Strategy:
 *   1. Load brands.json (1,144 known brands)
 *   2. Add a curated list of additional brand names discovered in products
 *   3. For each product without brand.name:
 *      - Try matching known brand (longest first, multi-word first)
 *      - Use word-boundary matching
 *   4. Save products-merged.json with extracted brand info
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

// Additional brands discovered from analyzing the data
const ADDITIONAL_BRANDS = [
  // Tobacco brands
  "مزایا", "بنگ بنگ", "ادالیا",
  // International FMCG
  "هداندشولدرز", "هد اند شولدرز", "هد اند شولدر", "head shoulders", "head & shoulders",
  "وینستون", "میلکا", "نستله", "نسکافه",
  "کیت کت", "کیتکت", "kit kat",
  "ام اند ام", "ام اند امز", "m&m", "M&M's",
  "ریتر اسپرت", "ریتراسپرت", "ritter sport",
  "امریکن گاردن", "american garden",
  "مارس", "اسنیکرز", "twix", "تویکس",
  "اورئو", "oreo", "بایکیت", "بایکیت شونیز",
  "اورئو میلکا",
  // Personal care
  "هیدرودرم", "hydroderm",
  "سانی سیلک", "سان سیلک", "سانسیلک", "sunsilk",
  "شوارتسکف", "شوارتزکف", "schwarzkopf",
  "لورآل", "لورال", "loreal", "l'oreal",
  "داو", "dove",
  "رکسونا", "rexona",
  "نیوآ", "nivea",
  "اولای", "olay",
  "گارنیه", "garnier",
  "پنتن", "pantene",
  "کلیر", "clear",
  "سین سین", "سان سین",
  "هرباسنس", "herbal essences",
  // Coffee/beverages
  "جرموک", "ویت بار", "عالیس",
  "رای نو", "راینو",
  "نوتلا", "nutella",
  // Food
  "فینیش", "finish",
  "پمینا",
  "اُ.آ.ب",
  "باخ",
  "اوراو", "اورئو", "اورو",
  // Batteries
  "گیگاسل", "دوراسل", "duracell",
  // Pet food
  "فریسکس", "نوتری پت", "ویسکاس",
  // Personal care - more
  "ایپک", "ایپک کیر",
  "پیکسل",
  "آتوسا",
  "لوسین",
  "لیورگارد",
  // Hygiene
  "فاکس", "فاگوس",
  "کت و کیدز", "وی کر",
  // Cleaning products
  "دیاهوم", "تاج", "ناتار",
  // Dairy
  "میهن", "پاک", "هراز",
  // International - common
  "ویتاکو", "ویتاکوئی",
  "نودلز", "هاتی نودلز",
  "هومی", "هومکر",
  // Pasta
  "مولیسانا", "دست جرمن",
  // Dairy
  "پمینا کاله",
  // Snacks
  "بای شیرین عسل", "شیرین عسل", "شیرین‌عسل",
  // Sauce & condiments
  "کیچن رز", "هینتز", "هاینز",
  // Other
  "پئوز", "نوین",
  // Beverages
  "کمپس", "اولترا پارادایس", "مانستر",
  // Cheese / dairy
  "کالین",
  // Spices
  "بهار",
  // Various
  "لاتو", "آوازه", "مانی", "شیبا", "نادری",
  // Discovered from v3 analysis (top frequent unbranded)
  "ژیلت", "gillette", "دتول", "dettol",
  "استارباکس", "starbucks",
  "لینت", "lindt", "جاکوبز", "jacobs",
  "تریدنت", "trident",
  "ایفل", "effax",
  "جانسون", "johnson", "جانسون ببی",
  "منتوس", "mentos",
  "بری", "blend",
  "سنسوداین", "sensodyne",
  "پرینگلز", "pringles",
  "کنور", "knorr",
  "اولکر", "ülker",
  "نظری", "کیندر", "kinder",
  "دادلان", "شونیز",
  "نسپرسو", "nespresso",
  "پالمولیو", "palmolive",
  "پمینا", "هراز",
  "لیسترین", "listerine",
  "توتال کر", "توتال", "کر",
  "آندرا میلانو", "آندرا", "میلانو",
  "گوموش",
  "تیک تاک", "tic tac",
  "یامی",
  "هربکس", "herbex",
  "وینات",
  "آرو", "دکتر بن",
  "پژآیس",
  "پرشین گاردن", "پرشین", "گاردن",
  "آلپن گلد", "آلپن", "alpen gold",
  "معینی پور", "معینی",
  "موهیتو", "فرشی",
  "اولترا پارادایس", "اولترا", "پارادایس", "مانستر", "monster",
  "هاینز", "heinz", "هینتز",
  "نوتلا", "nutella",
  "هاتی نودلز", "هاتی",
  "ویسکاس", "whiskas",
  "دوراسل", "duracell",
  "مولیسانا",
  "ناتار", "دیاهوم",
  "ایپک", "آتوسا", "لوسین", "لیورگارد", "ویتاکو",
  "هومکر",
  // More discovered brands (v3 second pass)
  "دلوکا", "deloca",
  "هیزم",
  "لوریس",
  "روشن کیک", "روشن",
  "یورک", "york",
  "آندره",
  "هرمس", "hermes",
  "بس",
  "ترنم متین", "ترنم",
  "گلدن ویو", "گلدن",
  "زهرا",
  "بالتیکا", "baltika",
  "آلویز", "allois",
  "شو",
  "نویر",
  "کاپو", "kapo",
  "کامپس", "compos",
  "گیلانی",
  "لوریس",
  "ویو",
  "هربکس",
  "دکتر بن",
  "آرو",
  "نودل", "نودلز",
  "ویتنر", "vitner",
  "دورینا", "dorina",
  "کاپریسون", "capri sun",
  "موهیتو",
  "ترش",
  "میلکا",
  "بایکیت",
  "شونیز",
  "بای شیرین عسل",
];

function main() {
  console.log("=== Loading data ===");
  const brandsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "brands.json"), 'utf8')).brands;
  console.log(`Known brands from API: ${brandsData.length}`);

  // Combine known brands + additional ones
  const allBrands = new Map(); // norm → {id, name}
  for (const b of brandsData) {
    const norm = normalizeFa(b.name);
    if (norm.length >= 2) allBrands.set(norm, { id: b.id, name: b.name.trim(), source: "api" });
  }
  for (const name of ADDITIONAL_BRANDS) {
    const norm = normalizeFa(name);
    if (!allBrands.has(norm) && norm.length >= 2) {
      allBrands.set(norm, { id: null, name: name.trim(), source: "discovered" });
    }
  }
  console.log(`Total brands (api + discovered): ${allBrands.size}`);

  // Split into single-word and multi-word
  const brandList = Array.from(allBrands.values());
  const multiWordBrands = brandList
    .map(b => ({ ...b, norm: normalizeFa(b.name), words: normalizeFa(b.name).split(/\s+/) }))
    .filter(b => b.words.length > 1)
    .sort((a, b) => b.norm.length - a.norm.length);

  const singleWordBrands = new Map();
  for (const b of brandList) {
    const norm = normalizeFa(b.name);
    const words = norm.split(/\s+/);
    if (words.length === 1 && norm.length >= 3) {
      singleWordBrands.set(norm, b);
    }
  }

  // Add some short single-word brands that we trust
  for (const shortBrand of ["میهن", "پاک", "نوآ", "آوازه", "نادری", "مانی", "بهار", "لاتو", "شیبا", "دوو", "تاج"]) {
    const norm = normalizeFa(shortBrand);
    if (!singleWordBrands.has(norm)) {
      singleWordBrands.set(norm, { id: null, name: shortBrand, source: "discovered" });
    }
  }

  console.log(`Single-word brands: ${singleWordBrands.size}`);
  console.log(`Multi-word brands: ${multiWordBrands.length}`);

  // Read all products
  const files = fs.readdirSync(PRODUCTS_DIR).filter(f => /^page-\d+\.json$/.test(f)).sort((a, b) => {
    return parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]);
  });
  const allProducts = new Map();
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(PRODUCTS_DIR, f), 'utf8'));
    for (const item of data.items) {
      if (!allProducts.has(item.id)) allProducts.set(item.id, item);
    }
  }
  console.log(`Unique products: ${allProducts.size}`);

  const stats = {
    total: allProducts.size,
    directBrand: 0,
    extractedBrand: 0,
    stillNoBrand: 0,
    withCategory: 0,
    withoutCategory: 0,
  };
  const stillNoBrandSamples = [];
  const extractedSamples = [];

  const productsArray = [];
  for (const item of allProducts.values()) {
    const label = item.name_fa?.trim() || "";

    let brandName = null;
    let brandId = null;
    let brandMethod = null;
    let brandSource = null;

    if (item.brand && item.brand.name) {
      brandName = item.brand.name.trim();
      brandId = item.brand_id;
      brandMethod = "direct";
      brandSource = "api";
      stats.directBrand++;
    } else {
      const norm = normalizeFa(label);

      // 1. Try multi-word brands first (more specific)
      for (const b of multiWordBrands) {
        if (norm.includes(b.norm)) {
          brandName = b.name;
          brandId = b.id;
          brandMethod = "extracted";
          brandSource = b.source;
          stats.extractedBrand++;
          if (extractedSamples.length < 15) {
            extractedSamples.push({ name: label, brand: b.name, type: "multi", source: b.source });
          }
          break;
        }
      }

      // 2. If not found, try single-word brands (token match)
      if (!brandName) {
        const tokens = tokenize(label);
        for (const t of tokens) {
          if (singleWordBrands.has(t)) {
            const b = singleWordBrands.get(t);
            brandName = b.name;
            brandId = b.id;
            brandMethod = "extracted";
            brandSource = b.source;
            stats.extractedBrand++;
            if (extractedSamples.length < 15) {
              extractedSamples.push({ name: label, brand: b.name, type: "single", source: b.source });
            }
            break;
          }
        }
      }
    }

    if (!brandName) {
      stats.stillNoBrand++;
      if (stillNoBrandSamples.length < 30) {
        stillNoBrandSamples.push({ name: label, source: item.source });
      }
    }

    if (item.category_id) stats.withCategory++;
    else stats.withoutCategory++;

    productsArray.push({
      ...item,
      _extracted: {
        brandName,
        brandId,
        brandMethod,
        brandSource,
      }
    });
  }

  // Save merged data
  console.log("\n=== Saving merged data ===");
  fs.writeFileSync(
    path.join(DATA_DIR, "products-merged.json"),
    JSON.stringify({
      generated_at: new Date().toISOString(),
      total_products: productsArray.length,
      stats,
      products: productsArray,
    }, null, 2)
  );

  console.log("\n=== Stats ===");
  console.log(`Total products: ${stats.total}`);
  console.log(`With direct brand: ${stats.directBrand} (${(stats.directBrand/stats.total*100).toFixed(1)}%)`);
  console.log(`With extracted brand: ${stats.extractedBrand} (${(stats.extractedBrand/stats.total*100).toFixed(1)}%)`);
  console.log(`Still without brand: ${stats.stillNoBrand} (${(stats.stillNoBrand/stats.total*100).toFixed(1)}%)`);
  console.log(`With category: ${stats.withCategory} (${(stats.withCategory/stats.total*100).toFixed(1)}%)`);
  console.log("");
  console.log("=== Sample extracted brands ===");
  for (const s of extractedSamples) {
    console.log(`  [${s.type}] "${s.name}" → "${s.brand}"`);
  }
  console.log("");
  console.log("=== Sample still without brand ===");
  for (const s of stillNoBrandSamples) {
    console.log(`  [${s.source}] "${s.name}"`);
  }
}

main();
