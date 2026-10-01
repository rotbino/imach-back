/**
 * Import products from cached JSON files → iMach DB.
 *
 * Strategy:
 *   1. First pass: read all cached pages, build a global set of known brand names
 *      (from items where item.brand.name is not null).
 *   2. Second pass: for each item, determine brand:
 *      - If item.brand.name exists → use it directly.
 *      - Else, search name_fa for any known brand name → use matched brand.
 *      - Else, fall back to "نامشخص" (unknown) brand — DO NOT skip.
 *   3. Create Good (product class) from clean_name.
 *   4. Create Product with full metadata.
 *
 * Usage: node import-from-cache.js [--dry-run] [--reset]
 *   --dry-run : only report stats, no DB writes
 *   --reset   : drop existing Product/Good/Brand collections first (DANGEROUS!)
 */
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const uri = "mongodb://uniqu434343:MirAli%40434343%2A@megancluster-shard-00-00.jm46r.mongodb.net:27017,megancluster-shard-00-01.jm46r.mongodb.net:27017,megancluster-shard-00-02.jm46r.mongodb.net:27017/imach_online_db?ssl=true&replicaSet=atlas-10bcqm-shard-0&authSource=admin&appName=MeganCluster";
const DATA_DIR = "/home/z/imach-back/local-data";

// ── Persian number normalization (matching iMach's normalizeFa)
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
    .replace(/\u200c/g, "")
    .toLowerCase()
    .trim();
}

// ── Map barcodeapp categories → iMach category slugs
const CAT_MAP = {
  "شیرینی و دسر": "snacks-sweets",
  "نوشیدنی‌ های سرد": "beverages",
  "نوشیدنی های سرد": "beverages",
  "بهداشت": "personal-care",
  "دستمال کاغذی": "tissue",
  "چیپس": "snacks-sweets",
  "پاک کننده سطوح و جرمگیر": "home-cleaning",
  "شوینده خانگی": "home-cleaning",
  "آرایشی": "cosmetics",
  "شامپو و مراقبت مو": "personal-care",
  "مراقبت شخصی": "personal-care",
  "بهداشت کودک": "baby-care",
  "پوشاک": "garments",
  "کفش": "shoes",
  "کیف و چرم": "bags-leather",
  "لوازم برقی بزرگ": "major-appliances",
  "لوازم برقی آشپزخانه": "kitchen-electric",
  "ظروف و سرویس": "cookware",
  "روغن و خواربار": "oils",
  "حبوبات": "legumes",
  "برنج": "rice",
  "لبنیات": "dairy",
  "قند، شکر و چای": "sugar-tea",
  "خشکبار و آجیل": "dried-fruit",
  "زعفران و ادویه": "spices-saffron",
  "آرد و غلات": "flour-cereals",
  "پروتئین و کنسرو": "protein-canned",
  "میوه و سبزیجات": "fresh-produce",
  "نوشیدنی": "beverages",
  "تنقلات": "snacks-sweets",
  "مواد شیمیایی": "chemicals",
  "مواد اولیه پلیمری": "polymer-raw",
  "رنگ و رزین": "paints-colors",
  "سیم و کابل": "wires-cables",
  "روشنایی": "lighting",
  "تابلو و کلید پریز": "switchgear",
  "باتری و انرژی": "batteries-power",
  "مقاطع فولادی": "steel-sections",
  "ابزار برقی": "power-tools",
  "ابزار دستی": "hand-tools",
  "جوش و برش": "welding",
  "یراق و اتصالات": "fasteners",
  "سیمان، گچ و آجر": "cement-plaster",
  "لوله و شیرآلات": "pipes-fittings",
  "کاشی، سرامیک و سنگ": "tile-stone",
  "عایق و ایزولاسیون": "insulation",
  "سرامیک بهداشتی": "sanitary-ware",
  "کارتن و مقوا": "cartons",
  "نایلون و فیلم": "films-nylons",
  "چاپ و لیبل": "labels-print",
  "ظروف یکبارمصرف": "disposables",
  "دام زنده": "live-animals",
  "طیور و تخم‌مرغ": "poultry-eggs",
  "آبزیان": "aquaculture",
  "خوراک دام و طیور": "animal-feed",
  "علوفه": "forage",
  "بذر و نهال": "seeds-plants",
  "کود": "fertilizers",
  "سموم کشاورزی": "pesticides",
  "تجهیزات گلخانه": "greenhouse",
  "مبلمان خانگی": "home-furniture",
  "مبلمان اداری": "office-furniture",
  "دکور و تزئینات": "decor",
  "صنایع دستی": "handicrafts",
  "اسباب‌بازی": "toys",
  "تجهیزات ورزشی": "sports-equip",
  "موبایل و لوازم جانبی": "mobile-accessories",
  "کامپیوتر و شبکه": "computer-network",
  "ذخیره‌سازی": "storage",
  "فرش و منسوجات خانه": "carpets-rugs",
  "پارچه": "fabrics",
  "نخ و الیاف": "yarn",
  "پوشاک عمده": "garments",
  "رب، سس و غذای آماده": "prepared-food",
  "افزودنی خوراکی": "food-additives",
  "تجهیزات آزمایشگاه": "lab-equip",
  "تجهیزات درمانی": "medical-equip",
  "مصرفی پزشکی": "medical-consumables",
  "ضایعات فلزی": "scrap-metal",
  "ضایعات پلاستیک": "scrap-plastic",
  "ضایعات کاغذ": "scrap-paper",
  "بدنه و چراغ": "body-parts",
  "روغن و مایعات خودرو": "car-oils",
  "قطعات یدکی": "spare-parts",
  "لاستیک": "tires",
  "مصرفی اداری": "office-consumables",
  "نوشت‌افزار": "stationery",
  "کاغذ و دفتر": "paper-books",
  "تجهیزات صنعت غذا": "food-industry",
  "جابه‌جایی مواد": "material-handling",
  "ماشین‌آلات تولید": "production-machines",
  "پمپ و کمپرسور": "pumps-compressors",
  "طلا و گرانبها": "precious-metals",
  "فلزات غیرآهنی": "non-ferrous",
  "سیسمونی و کودک": "kids-baby",
};

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const reset = process.argv.includes("--reset");

  console.log(`Mode: ${dryRun ? "DRY-RUN" : "LIVE"} | Reset: ${reset ? "YES" : "no"}`);

  // ── Step 1: Read all cached pages
  console.log("\n=== Step 1: Reading cached pages ===");
  const files = fs.readdirSync(DATA_DIR).filter(f => /^product-\d+\.json$/.test(f)).sort((a, b) => {
    return parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]);
  });
  console.log(`Found ${files.length} cached pages`);

  const allItems = [];
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f)));
    for (const item of data.items) {
      allItems.push(item);
    }
  }
  console.log(`Total items loaded: ${allItems.length}`);

  // ── Step 2: Build global brand set (from items WITH brand)
  console.log("\n=== Step 2: Building brand set from items with brand ===");
  const brandSet = new Set();
  const brandSetNormalized = new Map(); // normalized → original
  for (const item of allItems) {
    if (item.brand && item.brand.name) {
      const name = item.brand.name.trim();
      brandSet.add(name);
      brandSetNormalized.set(normalizeFa(name), name);
    }
  }
  console.log(`Known brands: ${brandSet.size}`);

  // ── Step 3: Determine brand for every item
  console.log("\n=== Step 3: Determining brand for each item ===");
  const stats = {
    directBrand: 0,
    matchedInName: 0,
    fallback: 0,
    skippedShortLabel: 0,
  };

  const processedItems = [];
  // Build brand lookup patterns sorted by length desc (longer matches first)
  const brandNames = Array.from(brandSetNormalized.values()).sort((a, b) => b.length - a.length);
  const brandNormNames = brandNames.map(n => ({ original: n, normalized: normalizeFa(n) }));

  for (const item of allItems) {
    const label = item.name_fa?.trim() || "";
    if (label.length < 2) {
      stats.skippedShortLabel++;
      continue;
    }

    let brandName = null;
    // Try direct
    if (item.brand && item.brand.name) {
      brandName = item.brand.name.trim();
      stats.directBrand++;
    } else {
      // Try matching known brand in name_fa (normalized comparison)
      const labelNorm = normalizeFa(label);
      for (const { original, normalized } of brandNormNames) {
        if (labelNorm.includes(normalized)) {
          brandName = original;
          stats.matchedInName++;
          break;
        }
      }
    }

    if (!brandName) {
      // Fallback: use "نامشخص" instead of skipping
      brandName = "نامشخص";
      stats.fallback++;
    }

    processedItems.push({ item, brandName, label });
  }

  console.log(`  Direct brand from API: ${stats.directBrand}`);
  console.log(`  Matched in name_fa: ${stats.matchedInName}`);
  console.log(`  Fallback "نامشخص": ${stats.fallback}`);
  console.log(`  Skipped (short label): ${stats.skippedShortLabel}`);
  console.log(`  Total processed: ${processedItems.length}`);

  if (dryRun) {
    console.log("\n=== DRY-RUN complete — no DB writes ===");
    return;
  }

  // ── Step 4: Connect to DB
  console.log("\n=== Step 4: Connecting to MongoDB ===");
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('imach_online_db');

  if (reset) {
    console.log("⚠️  Dropping Product, Good, Brand collections...");
    await db.collection('Product').deleteMany({});
    await db.collection('Good').deleteMany({});
    await db.collection('Brand').deleteMany({});
    console.log("  Done.");
  }

  // ── Find admin user
  const admin = await db.collection('User').findOne({ role: "ADMIN" });
  if (!admin) { console.log("No admin user found"); await client.close(); return; }
  console.log(`Admin: ${admin.name} (${admin._id})`);

  // ── Find "سایر › جدید" category for fallback
  const jadidCat = await db.collection('Category').findOne({ slug: "jadid" });
  if (!jadidCat) { console.log("Category 'jadid' not found"); await client.close(); return; }

  // Cache all categories by slug
  const allCats = await db.collection('Category').find({}).toArray();
  const catBySlug = new Map();
  for (const c of allCats) catBySlug.set(c.slug, c);

  // ── Step 5: Pass A — Create all brands (deduped)
  console.log("\n=== Step 5: Creating brands ===");
  const allBrandNames = new Set(processedItems.map(p => p.brandName));
  const brandCache = new Map();
  for (const name of allBrandNames) {
    const norm = normalizeFa(name);
    let brand = await db.collection('Brand').findOne({ searchText: norm });
    if (!brand) {
      const insertResult = await db.collection('Brand').insertOne({
        name,
        searchText: norm,
        source: "SEED",
        status: "ACTIVE",
        creatorRole: "ADMIN",
        createdById: admin._id,
        ownerId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      brand = { _id: insertResult.insertedId, name };
    }
    brandCache.set(name, brand);
  }
  console.log(`  Total brands in DB: ${await db.collection('Brand').countDocuments()}`);

  // ── Step 6: Pass B — Create all goods (deduped by searchText)
  console.log("\n=== Step 6: Creating goods ===");
  const goodCache = new Map(); // searchText → good
  for (const { item, brandName, label } of processedItems) {
    let cleanName = item.metadata?.clean_name || "";
    if (!cleanName) {
      cleanName = item.name_fa?.split(" ")[0] || brandName;
    }
    const cleanWords = cleanName.split(" ").filter(w => w.length > 0);
    if (cleanWords.length > 2) {
      cleanName = cleanWords.slice(0, 2).join(" ");
    }
    const brandInClean = cleanWords[cleanWords.length - 1];
    if (brandName && normalizeFa(brandInClean) === normalizeFa(brandName)) {
      cleanWords.pop();
      cleanName = cleanWords.join(" ");
    }
    if (!cleanName || cleanName.length < 1) cleanName = "نامشخص";

    const goodSt = normalizeFa(cleanName);
    if (goodCache.has(goodSt)) continue;

    let good = await db.collection('Good').findOne({ searchText: goodSt });
    if (!good) {
      const bcatName = item.category?.name || item.metadata?.source_taxonomy?.subcategory;
      let categoryId = jadidCat._id;
      let unit = "PIECE";
      if (bcatName && CAT_MAP[bcatName]) {
        const mappedCat = catBySlug.get(CAT_MAP[bcatName]);
        if (mappedCat) {
          categoryId = mappedCat._id;
          unit = mappedCat.unit || "PIECE";
        }
      }
      const insertResult = await db.collection('Good').insertOne({
        nameFa: cleanName,
        nameEn: null,
        aliases: [],
        searchText: goodSt,
        unit,
        categoryId,
        hsCode: null,
        source: "SEED",
        status: "ACTIVE",
        creatorRole: "ADMIN",
        createdById: admin._id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      good = { _id: insertResult.insertedId, nameFa: cleanName, categoryId, unit };
    }
    goodCache.set(goodSt, good);
  }
  console.log(`  Total goods in DB: ${await db.collection('Good').countDocuments()}`);

  // ── Step 7: Pass C — Create all products
  console.log("\n=== Step 7: Creating products ===");
  let productsCreated = 0;
  let productsSkipped = 0;

  for (const { item, brandName, label } of processedItems) {
    let cleanName = item.metadata?.clean_name || "";
    if (!cleanName) {
      cleanName = item.name_fa?.split(" ")[0] || brandName;
    }
    const cleanWords = cleanName.split(" ").filter(w => w.length > 0);
    if (cleanWords.length > 2) {
      cleanName = cleanWords.slice(0, 2).join(" ");
    }
    const brandInClean = cleanWords[cleanWords.length - 1];
    if (brandName && normalizeFa(brandInClean) === normalizeFa(brandName)) {
      cleanWords.pop();
      cleanName = cleanWords.join(" ");
    }
    if (!cleanName || cleanName.length < 1) cleanName = "نامشخص";

    const goodSt = normalizeFa(cleanName);
    const good = goodCache.get(goodSt);
    const brand = brandCache.get(brandName);

    const searchText = normalizeFa(label);
    const barcode = item.barcode || "";
    const imageUrl = item.image_url || null;

    // Check duplicate
    let existing = null;
    if (barcode) {
      existing = await db.collection('Product').findOne({ barcode, status: { $ne: "MERGED" } });
    }
    if (!existing) {
      existing = await db.collection('Product').findOne({
        goodId: good._id,
        brandId: brand._id,
        searchText,
        status: { $ne: "MERGED" },
      });
    }
    if (existing) {
      productsSkipped++;
      continue;
    }

    // Build attrs
    const attrs = {};
    if (item.metadata?.parsed_attributes) {
      for (const attr of item.metadata.parsed_attributes) {
        attrs[attr.name] = attr.value;
      }
    }
    if (item.weight_grams) attrs.weight_grams = String(item.weight_grams);
    if (item.metadata?.volume_ml) attrs.volume_ml = String(item.metadata.volume_ml);

    const metadata = {
      source: "barcodeapp",
      source_id: item.id,
      original_name: item.metadata?.original_name || item.name_fa,
      clean_name: item.metadata?.clean_name,
      parsed_brand: item.metadata?.parsed_brand,
      parsed_attributes: item.metadata?.parsed_attributes || [],
      volume_ml: item.metadata?.volume_ml || null,
      weight_grams: item.weight_grams || null,
      pack_count: item.metadata?.pack_count || null,
      data_confidence: item.data_confidence,
      is_verified: item.is_verified,
      usage_count: item.usage_count,
      suggested_variant: item.metadata?.suggested_variant_name,
      default_unit: item.default_unit,
      barcodeapp_category: item.category?.name || item.metadata?.source_taxonomy?.category || null,
      barcodeapp_subcategory: item.metadata?.source_taxonomy?.subcategory || null,
      barcodeapp_brand_id: item.brand_id || null,
      barcodeapp_category_id: item.category_id || null,
      brand_extraction_method: item.brand?.name ? "direct" : (brandName !== "نامشخص" ? "name_match" : "fallback"),
      imported_at: new Date().toISOString(),
    };

    await db.collection('Product').insertOne({
      goodId: good._id,
      brandId: brand._id,
      label,
      searchText,
      barcode: barcode || null,
      imageUrl,
      attrs: Object.keys(attrs).length > 0 ? attrs : null,
      metadata,
      status: "ACTIVE",
      creatorRole: "ADMIN",
      createdById: admin._id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    productsCreated++;
    if (productsCreated % 100 === 0) {
      console.log(`  Created ${productsCreated} products... (skipped ${productsSkipped})`);
    }
  }

  console.log(`\n=== Import complete ===`);
  console.log(`Products created: ${productsCreated}`);
  console.log(`Products skipped (duplicates): ${productsSkipped}`);
  console.log(`Total Brands: ${await db.collection('Brand').countDocuments()}`);
  console.log(`Total Goods: ${await db.collection('Good').countDocuments()}`);
  console.log(`Total Products: ${await db.collection('Product').countDocuments()}`);

  await client.close();
}

main().catch(e => { console.error(e); process.exit(1); });
