/**
 * Analyze products-all data and extract brands from product names.
 * Improved v2: word-boundary matching, min length 3, better detection.
 *
 * Strategy:
 *   1. Read brands.json (1,144 known brands)
 *   2. For each product without brand.name:
 *      - Tokenize name_fa into words (handling ZWNJ, dots, dashes)
 *      - For each known brand, check if any word/phrase matches
 *      - Use word-boundary matching to avoid false positives
 *   3. Generate report and save merged data
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = "/home/z/imach-back/local-data";
const PRODUCTS_DIR = path.join(DATA_DIR, "products-all");

// ── Persian normalization
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
    .replace(/\u200c/g, " ")  // ZWNJ → space (so we can split on words)
    .toLowerCase()
    .trim();
}

// Tokenize: split on spaces, dots, dashes, parens
function tokenize(text) {
  return normalizeFa(text)
    .replace(/[.,;:()؟!'"«»\-_/\\]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 0);
}

// Build n-gram tokens (1, 2, 3-word phrases)
function tokenizeN(text, n) {
  const words = tokenize(text);
  const phrases = [];
  for (let i = 0; i <= words.length - n; i++) {
    phrases.push(words.slice(i, i + n).join(" "));
  }
  return phrases;
}

function main() {
  console.log("=== Loading data ===");
  const brands = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "brands.json"), 'utf8')).brands;
  console.log(`Known brands: ${brands.length}`);

  // Build brand lookup with normalized name + length
  // Filter out brands with normalized length < 3 (too short, prone to false positives)
  // Also filter very generic short names
  const SHORT_BLOCKLIST = new Set(["دان", "رمی", "مز", "نو", "آر", "مین", "تک", "بر", "پاک", "ناز", "نور", "روغن", "شیر", "ماست", "پنیر", "کیک", "نان"]);
  const brandList = brands
    .map(b => ({ id: b.id, name: b.name.trim(), norm: normalizeFa(b.name) }))
    .filter(b => b.norm.length >= 3 && !SHORT_BLOCKLIST.has(b.norm))
    .sort((a, b) => b.norm.length - a.norm.length);

  console.log(`Filtered brands (len>=3, non-generic): ${brandList.length}`);

  // Build lookup: normalized brand name → brand
  // For multi-word brands, we'll match exact phrase
  // For single-word brands, we'll match as standalone token
  const singleWordBrands = new Map(); // norm → brand
  const multiWordBrands = []; // array (sorted by length DESC)

  for (const b of brandList) {
    const words = b.norm.split(/\s+/);
    if (words.length === 1) {
      singleWordBrands.set(b.norm, b);
    } else {
      multiWordBrands.push({ ...b, phrase: b.norm, words });
    }
  }
  console.log(`Single-word brands: ${singleWordBrands.size}`);
  console.log(`Multi-word brands: ${multiWordBrands.length}`);

  // Read all products
  const files = fs.readdirSync(PRODUCTS_DIR).filter(f => /^page-\d+\.json$/.test(f)).sort((a, b) => {
    return parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]);
  });
  console.log(`Product page files: ${files.length}`);

  const allProducts = new Map();
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(PRODUCTS_DIR, f), 'utf8'));
    for (const item of data.items) {
      if (!allProducts.has(item.id)) {
        allProducts.set(item.id, item);
      }
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

    if (item.brand && item.brand.name) {
      brandName = item.brand.name.trim();
      brandId = item.brand_id;
      brandMethod = "direct";
      stats.directBrand++;
    } else {
      const tokens = tokenize(label);
      const tokenSet = new Set(tokens);

      // 1. Try multi-word brands first (more specific)
      for (const b of multiWordBrands) {
        if (label.includes(b.name) || normalizeFa(label).includes(b.phrase)) {
          brandName = b.name;
          brandId = b.id;
          brandMethod = "extracted";
          stats.extractedBrand++;
          if (extractedSamples.length < 10) {
            extractedSamples.push({ name: label, brand: b.name, type: "multi" });
          }
          break;
        }
      }

      // 2. If not found, try single-word brands (must match exact token)
      if (!brandName) {
        for (const t of tokens) {
          if (singleWordBrands.has(t)) {
            const b = singleWordBrands.get(t);
            brandName = b.name;
            brandId = b.id;
            brandMethod = "extracted";
            stats.extractedBrand++;
            if (extractedSamples.length < 10) {
              extractedSamples.push({ name: label, brand: b.name, type: "single" });
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
      brands_known: brands.length,
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
