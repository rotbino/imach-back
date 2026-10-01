/**
 * Import products v2 — bulkWrite + batch processing for speed.
 *
 * Strategy:
 *   1. Read products-merged.json (42,027 products)
 *   2. Drop existing Brand, Good, Product (if not already)
 *   3. Bulk insert all brands
 *   4. Bulk insert all goods (deduped by searchText)
 *   5. Bulk insert all products (with duplicate detection in-memory)
 *
 * Usage:
 *   node import-final-v2.js --dry-run    # test
 *   node import-final-v2.js              # live
 *   node import-final-v2.js --resume     # resume from where v1 stopped
 */
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const { BC_TO_IMACH, DEFAULT_MAPPING } = require('./category-map');

const uri = "mongodb://uniqu434343:MirAli%40434343%2A@megancluster-shard-00-00.jm46r.mongodb.net:27017,megancluster-shard-00-01.jm46r.mongodb.net:27017,megancluster-shard-00-02.jm46r.mongodb.net:27017/imach_online_db?ssl=true&replicaSet=atlas-10bcqm-shard-0&authSource=admin&appName=MeganCluster";
const DATA_DIR = "/home/z/imach-back/local-data";
const MERGED_FILE = path.join(DATA_DIR, "products-merged.json");

// ── Persian normalization
function normalizeFa(text) {
  if (!text) return "";
  return text
    .replace(/[\u06F0-\u06F9]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x06F0 + 0x0030))
    .replace(/[\u0660-\u0669]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x0660 + 0x0030))
    .replace(/ي/g, "ی").replace(/ك/g, "ک")
    .replace(/أ|إ|آ/g, "ا").replace(/ة/g, "ه")
    .replace(/ؤ/g, "و").replace(/ئ/g, "ی")
    .replace(/\u200c/g, "")
    .toLowerCase().trim();
}

function resolveImachCategory(item, catBySlug, jadidCat) {
  const bcCatName = item.category?.name;
  const stCat = item.metadata?.source_taxonomy?.subcategory;
  const stParentCat = item.metadata?.source_taxonomy?.category;
  const candidates = [bcCatName, stCat, stParentCat].filter(Boolean);
  for (const cand of candidates) {
    if (BC_TO_IMACH[cand]) {
      const slug = BC_TO_IMACH[cand];
      const cat = catBySlug.get(slug);
      if (cat) return cat;
    }
  }
  return jadidCat;
}

function extractGoodName(item, brandName) {
  let cleanName = item.metadata?.clean_name || "";
  if (!cleanName) {
    const words = (item.name_fa || "").split(/\s+/).filter(w => w.length > 0);
    cleanName = words.slice(0, 2).join(" ");
  }
  if (brandName && brandName !== "نامشخص") {
    const norm = normalizeFa(brandName);
    const cleanNorm = normalizeFa(cleanName);
    if (cleanNorm.endsWith(" " + norm) || cleanNorm === norm) {
      cleanName = cleanName.replace(new RegExp(brandName + "\\s*$", "u"), "").trim();
    }
  }
  cleanName = cleanName.replace(/\([^)]*\)/g, "").trim();
  cleanName = cleanName.replace(/\s+\d+\s*(گرم|کیلو|میلی|لیتر|عدد|پاکت).*/i, "").trim();
  if (brandName && brandName !== "نامشخص") {
    const norm = normalizeFa(brandName);
    const cleanNorm = normalizeFa(cleanName);
    if (cleanNorm.endsWith(" " + norm) || cleanNorm === norm) {
      cleanName = cleanName.replace(new RegExp(brandName + "\\s*$", "u"), "").trim();
    }
  }
  if (cleanName.length < 2) {
    cleanName = (item.name_fa || "").split(/\s+/)[0] || brandName || "نامشخص";
  }
  const words = cleanName.split(/\s+/).filter(w => w.length > 0);
  if (words.length > 4) cleanName = words.slice(0, 4).join(" ");
  return cleanName;
}

function buildAttrs(item) {
  const attrs = {};
  if (item.metadata?.parsed_attributes && Array.isArray(item.metadata.parsed_attributes)) {
    for (const attr of item.metadata.parsed_attributes) {
      if (attr.name && attr.value) attrs[attr.name] = attr.value;
    }
  }
  if (item.weight_grams) attrs.weight_grams = String(item.weight_grams);
  if (item.metadata?.volume_ml) attrs.volume_ml = String(item.metadata.volume_ml);
  if (item.metadata?.pack_count) attrs.pack_count = String(item.metadata.pack_count);
  return Object.keys(attrs).length > 0 ? attrs : null;
}

function buildMetadata(item, brandMethod, brandSource) {
  return {
    source: "barcodeapp",
    source_id: item.id,
    source_kind: item.source,
    original_name: item.name_fa,
    clean_name: item.metadata?.clean_name || null,
    parsed_brand: item.metadata?.parsed_brand || null,
    parsed_attributes: item.metadata?.parsed_attributes || [],
    suggested_variant: item.metadata?.suggested_variant_name || null,
    volume_ml: item.metadata?.volume_ml || null,
    weight_grams: item.weight_grams || null,
    pack_count: item.metadata?.pack_count || null,
    ai_parsed: item.metadata?.ai_parsed || false,
    barcodeapp_category: item.category?.name || null,
    barcodeapp_subcategory: item.metadata?.source_taxonomy?.subcategory || null,
    barcodeapp_taxonomy_category: item.metadata?.source_taxonomy?.category || null,
    barcodeapp_brand_id: item.brand_id || null,
    barcodeapp_category_id: item.category_id || null,
    brand_extraction_method: brandMethod,
    brand_extraction_source: brandSource,
    data_confidence: item.data_confidence,
    is_verified: item.is_verified,
    usage_count: item.usage_count || 0,
    usage_by_store_type: item.usage_by_store_type || {},
    usage_by_city: item.usage_by_city || {},
    default_unit: item.default_unit,
    default_unit_step: item.default_unit_step,
    reference_price: item.reference_price,
    last_price_update: item.last_price_update || null,
    barcodeapp_created_at: item.created_at,
    barcodeapp_updated_at: item.updated_at,
    imported_at: new Date().toISOString(),
  };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const resume = process.argv.includes("--resume");

  console.log("=== Import final v2 (bulkWrite) ===");
  console.log("Mode: " + (dryRun ? "DRY-RUN" : "LIVE") + (resume ? " (resume)" : ""));

  // Load merged products
  console.log("Loading products-merged.json...");
  const merged = JSON.parse(fs.readFileSync(MERGED_FILE, 'utf8'));
  const products = merged.products;
  console.log("Total products: " + products.length);

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('imach_online_db');

  if (!dryRun && !resume) {
    console.log("⚠️  Dropping Product, Good, Brand collections...");
    await db.collection('Product').deleteMany({});
    await db.collection('Good').deleteMany({});
    await db.collection('Brand').deleteMany({});
    console.log("  Done.");
  }

  // Find admin
  const admin = await db.collection('User').findOne({ role: "ADMIN" });
  if (!admin) throw new Error("No admin user");
  console.log("Admin: " + admin.name);

  // Cache iMach categories
  const allCats = await db.collection('Category').find({}).toArray();
  const catBySlug = new Map(allCats.map(c => [c.slug, c]));
  const jadidCat = catBySlug.get("jadid");
  if (!jadidCat) throw new Error("jadid category not found");

  // ─── PASS A: Create all brands (bulkWrite) ───
  console.log("");
  console.log("=== Pass A: Create all brands ===");
  const brandMap = new Map();
  for (const p of products) {
    const bn = p._extracted?.brandName;
    if (!bn) continue;
    const norm = normalizeFa(bn);
    if (!brandMap.has(norm)) {
      brandMap.set(norm, {
        name: bn,
        source: p._extracted.brandSource || "api",
        count: 0
      });
    }
    brandMap.get(norm).count++;
  }
  console.log("Unique brands: " + brandMap.size);

  const brandCache = new Map();
  if (!dryRun) {
    // If resume, load existing brands
    if (resume) {
      const existing = await db.collection('Brand').find({}).toArray();
      for (const b of existing) brandCache.set(b.searchText, b);
      console.log("Loaded " + brandCache.size + " existing brands (resume mode)");
    }
    const toInsert = [];
    for (const [norm, info] of brandMap) {
      if (brandCache.has(norm)) continue;
      toInsert.push({
        name: info.name,
        searchText: norm,
        source: "SEED",
        status: "ACTIVE",
        creatorRole: "ADMIN",
        createdById: admin._id,
        ownerId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    console.log("Brands to insert: " + toInsert.length);
    if (toInsert.length > 0) {
      // Batch insert (MongoDB max batch is 100k but we'll use 1000)
      const BATCH = 1000;
      for (let i = 0; i < toInsert.length; i += BATCH) {
        const batch = toInsert.slice(i, i + BATCH);
        const result = await db.collection('Brand').insertMany(batch);
        // Build cache from inserted docs
        for (let j = 0; j < batch.length; j++) {
          brandCache.set(batch[j].searchText, { _id: result.insertedIds[j], name: batch[j].name });
        }
        process.stdout.write(".");
      }
      console.log("");
    }
    console.log("Total brands in DB: " + await db.collection('Brand').countDocuments());
  }

  // ─── PASS B: Create all goods (bulkWrite) ───
  console.log("");
  console.log("=== Pass B: Create all goods ===");
  const goodCache = new Map();
  const goodsToCreate = new Map();
  for (const p of products) {
    const brandName = p._extracted?.brandName || "نامشخص";
    const cleanName = extractGoodName(p, brandName);
    const goodSt = normalizeFa(cleanName);
    if (goodSt.length < 1) continue;
    if (!goodsToCreate.has(goodSt)) {
      const cat = resolveImachCategory(p, catBySlug, jadidCat);
      goodsToCreate.set(goodSt, {
        nameFa: cleanName,
        searchText: goodSt,
        categoryId: cat._id,
        unit: cat.unit || "PIECE",
      });
    }
  }
  console.log("Unique goods: " + goodsToCreate.size);

  if (!dryRun) {
    if (resume) {
      const existing = await db.collection('Good').find({}).toArray();
      for (const g of existing) goodCache.set(g.searchText, g);
      console.log("Loaded " + goodCache.size + " existing goods (resume mode)");
    }
    const toInsert = [];
    for (const [st, g] of goodsToCreate) {
      if (goodCache.has(st)) continue;
      toInsert.push({
        nameFa: g.nameFa,
        nameEn: null,
        aliases: [],
        searchText: g.searchText,
        unit: g.unit,
        categoryId: g.categoryId,
        hsCode: null,
        source: "SEED",
        status: "ACTIVE",
        creatorRole: "ADMIN",
        createdById: admin._id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    console.log("Goods to insert: " + toInsert.length);
    const BATCH = 1000;
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const batch = toInsert.slice(i, i + BATCH);
      const result = await db.collection('Good').insertMany(batch);
      for (let j = 0; j < batch.length; j++) {
        goodCache.set(batch[j].searchText, { _id: result.insertedIds[j], nameFa: batch[j].nameFa, categoryId: batch[j].categoryId, unit: batch[j].unit });
      }
      process.stdout.write(".");
      if ((i + BATCH) % 5000 === 0) console.log(" " + goodCache.size + " goods");
    }
    console.log("");
    console.log("Total goods in DB: " + await db.collection('Good').countDocuments());
  }

  // ─── PASS C: Create all products (bulkWrite with in-memory dedup) ───
  console.log("");
  console.log("=== Pass C: Create all products ===");
  let productsCreated = 0;
  let productsSkipped = 0;
  const dupReasons = { noLabel: 0, noGood: 0, dupBarcode: 0, dupCombo: 0 };
  const seenBarcodes = new Set();
  const seenCombos = new Set();
  const BATCH = 1000;
  let toInsert = [];

  for (let idx = 0; idx < products.length; idx++) {
    const p = products[idx];
    const label = (p.name_fa || "").trim();
    if (label.length < 2) {
      productsSkipped++;
      dupReasons.noLabel++;
      continue;
    }

    const brandName = p._extracted?.brandName || "نامشخص";
    const brandNorm = normalizeFa(brandName);
    const brand = brandCache.get(brandNorm);
    const brandId = brand ? brand._id : null;

    const cleanName = extractGoodName(p, brandName);
    const goodSt = normalizeFa(cleanName);
    const good = goodCache.get(goodSt);
    if (!good) {
      productsSkipped++;
      dupReasons.noGood++;
      continue;
    }

    const searchText = normalizeFa(label);
    const barcode = p.barcode || "";
    const imageUrl = p.image_url || null;
    const attrs = buildAttrs(p);
    const metadata = buildMetadata(
      p,
      p._extracted?.brandMethod || "fallback",
      p._extracted?.brandSource || "fallback"
    );

    // Check duplicates in-memory
    if (barcode && seenBarcodes.has(barcode)) {
      productsSkipped++;
      dupReasons.dupBarcode++;
      continue;
    }
    const combo = goodSt + "|" + brandNorm + "|" + searchText;
    if (seenCombos.has(combo)) {
      productsSkipped++;
      dupReasons.dupCombo++;
      continue;
    }
    if (barcode) seenBarcodes.add(barcode);
    seenCombos.add(combo);

    toInsert.push({
      goodId: good._id,
      brandId: brandId,
      label,
      searchText,
      barcode: barcode || null,
      imageUrl,
      attrs,
      metadata,
      status: "ACTIVE",
      creatorRole: "ADMIN",
      createdById: admin._id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    if (toInsert.length >= BATCH) {
      if (!dryRun) {
        await db.collection('Product').insertMany(toInsert);
      }
      productsCreated += toInsert.length;
      toInsert = [];
      if (productsCreated % 5000 === 0) {
        console.log("  Created " + productsCreated + " products (skipped " + productsSkipped + ")...");
      }
    }
  }
  // Insert remaining
  if (toInsert.length > 0) {
    if (!dryRun) {
      await db.collection('Product').insertMany(toInsert);
    }
    productsCreated += toInsert.length;
  }

  console.log("");
  console.log("=== Pass C complete ===");
  console.log("Products created: " + productsCreated);
  console.log("Products skipped: " + productsSkipped);
  console.log("  no label: " + dupReasons.noLabel);
  console.log("  no good: " + dupReasons.noGood);
  console.log("  dup barcode: " + dupReasons.dupBarcode);
  console.log("  dup combo: " + dupReasons.dupCombo);

  // ─── Final summary ───
  console.log("");
  console.log("=== Final summary ===");
  console.log("Mode: " + (dryRun ? "DRY-RUN" : "LIVE"));
  console.log("Total input products: " + products.length);
  if (!dryRun) {
    console.log("DB state:");
    console.log("  Brands: " + await db.collection('Brand').countDocuments());
    console.log("  Goods: " + await db.collection('Good').countDocuments());
    console.log("  Products: " + await db.collection('Product').countDocuments());
  }
  await client.close();
}

main().catch(e => { console.error(e); process.exit(1); });
