/**
 * Import products from barcodeapp.ir API → iMach DB.
 * Creates Brands, Goods (if missing), and Products with full metadata.
 *
 * Usage: node import-barcodeapp.js [limit] [startPage]
 *   limit: number of products to import (default: 1)
 *   startPage: API page to start from (default: 1)
 */
const { MongoClient } = require('mongodb');
const uri = "mongodb://uniqu434343:MirAli%40434343%2A@megancluster-shard-00-00.jm46r.mongodb.net:27017,megancluster-shard-00-01.jm46r.mongodb.net:27017,megancluster-shard-00-02.jm46r.mongodb.net:27017/imach_online_db?ssl=true&replicaSet=atlas-10bcqm-shard-0&authSource=admin&appName=MeganCluster";

const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjMmVjMGY5NC1lZDEwLTQ3ZjUtYTA4Zi1lZWE5OTU5YjhkN2QiLCJwaG9uZSI6Iis5ODkxOTY0MjEyNjQiLCJzdG9yZUlkIjoiOTM0MzE3NjUtZTNiOS00N2IwLTg2NTItZjY5MjY3Yzg5NzE0Iiwicm9sZSI6InN0b3JlX293bmVyIiwic2lkIjoiYmFlOTQxZDItMjA5Ny00OGNmLWIwNWItODc5ZTYyZDZlZDQ3IiwidG9rZW5fdXNlIjoiYmFyY29kZV9hY2Nlc3MiLCJpYXQiOjE3OTA1NDEzMjksImV4cCI6MTc5MDU0MjIyOSwiYXVkIjoiYmFyY29kZS1hcGkiLCJpc3MiOiJiYXJjb2RlLWF1dGgifQ.44_-Onw3DqxZdwDVKOBIvILQGuwSaQas7u2f8bjHiw0";

const API_URL = "https://api.barcodeapp.ir/catalog/search";

// ── Persian number normalization (matching iMach's normalizeFa)
function normalizeFa(text) {
  if (!text) return "";
  return text
    .replace(/[\u06F0-\u06F9]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x06F0 + 0x0030)) // Persian digits → Latin
    .replace(/[\u0660-\u0669]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x0660 + 0x0030)) // Arabic digits → Latin
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/أ|إ|آ/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ی")
    .replace(/\u200c/g, "") // ZWNJ
    .toLowerCase()
    .trim();
}

function goodSearchText(name) {
  return normalizeFa(name);
}

// ── Map barcodeapp categories → iMach category slugs
// Key: barcodeapp category name, Value: iMach category slug
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
  "پروتئین و کنسرو": "protein-canned",
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
  "آبزیان": "aquaculture",
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
  const limit = parseInt(process.argv[2] || "1");
  const startPage = parseInt(process.argv[3] || "1");

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('imach_online_db');

  // ── Find admin user for createdById
  const admin = await db.collection('User').findOne({ role: "ADMIN" });
  if (!admin) { console.log("No admin user found"); await client.close(); return; }
  console.log(`Admin: ${admin.name} (${admin._id})`);

  // ── Find "سایر › جدید" category for new goods
  const jadidCat = await db.collection('Category').findOne({ slug: "jadid" });
  if (!jadidCat) { console.log("Category 'jadid' not found"); await client.close(); return; }

  // ── Cache: all existing categories by slug for CAT_MAP lookup
  const allCats = await db.collection('Category').find({}).toArray();
  const catBySlug = new Map();
  for (const c of allCats) {
    catBySlug.set(c.slug, c);
  }

  let imported = 0;
  let page = startPage;
  let perPage = 20;

  while (imported < limit) {
    console.log(`\n--- Fetching page ${page} (limit ${perPage}) ---`);
    const url = `${API_URL}?page=${page}&limit=${perPage}`;
    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Origin": "https://app.barcodeapp.ir",
        "Referer": "https://app.barcodeapp.ir/",
        "User-Agent": "Mozilla/5.0",
        "x-app-platform": "direct",
        "x-app-version": "1.1.56",
        "x-store-id": "93431765-e3b9-47b0-8652-f69267c89714",
      },
    });
    if (!res.ok) {
      console.log(`API returned ${res.status} — stopping`);
      break;
    }
    const data = await res.json();
    const items = data.items || [];
    console.log(`Got ${items.length} items (total: ${data.total})`);

    if (items.length === 0) break;

    for (const item of items) {
      if (imported >= limit) break;

      // ── Skip items without brand or with null brand
      if (!item.brand || !item.brand.name) {
        console.log(`  SKIP (no brand): ${item.name_fa}`);
        continue;
      }

      const brandName = item.brand.name.trim();
      // ── Good name: the CLASS of the product, not the specific product.
      // barcodeapp's clean_name is usually good but sometimes too specific.
      // Strategy:
      //   1. Use clean_name if ≤ 2 words
      //   2. If > 2 words, use first 1-2 words (the class name)
      //   3. If clean_name is empty, use first word of name_fa
      // Examples:
      //   "دسر شکلاتی" (2 words) → Good = "دسر شکلاتی" ✓
      //   "نوشابه کولا" (2 words) → Good = "نوشابه کولا" ✓
      //   "کیک روغنی خانواده" (3 words) → Good = "کیک روغنی" (first 2)
      //   "شامپو بدن سبز حاوی ویتامین ای" (6 words) → Good = "شامپو بدن" (first 2)
      let cleanName = item.metadata?.clean_name || "";
      if (!cleanName) {
        cleanName = item.name_fa?.split(" ")[0] || brandName;
      }
      const cleanWords = cleanName.split(" ").filter(w => w.length > 0);
      if (cleanWords.length > 2) {
        cleanName = cleanWords.slice(0, 2).join(" ");
      }
      // Remove brand name from clean name if it's at the end
      // e.g. "کیک روغنی نادری" → "کیک روغنی"
      const brandInClean = cleanWords[cleanWords.length - 1];
      if (brandName && normalizeFa(brandInClean) === normalizeFa(brandName)) {
        cleanWords.pop();
        cleanName = cleanWords.join(" ");
      }
      const label = item.name_fa?.trim() || "";
      const barcode = item.barcode || "";
      const imageUrl = item.image_url || null;

      if (label.length < 2) {
        console.log(`  SKIP (short label): ${label}`);
        continue;
      }

      // ── 1. Find or create Brand
      let brand = await db.collection('Brand').findOne({ searchText: normalizeFa(brandName) });
      if (!brand) {
        brand = await db.collection('Brand').insertOne({
          name: brandName,
          searchText: normalizeFa(brandName),
          source: "SEED",
          status: "ACTIVE",
          creatorRole: "ADMIN",
          createdById: admin._id.toString(),
          ownerId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        brand = { _id: brand.insertedId, name: brandName };
        console.log(`  + Brand created: ${brandName}`);
      }

      // ── 2. Find or create Good
      const goodSt = goodSearchText(cleanName);
      let good = await db.collection('Good').findOne({ searchText: goodSt });
      if (!good) {
        // Try finding by name contains
        good = await db.collection('Good').findOne({ nameFa: { $regex: cleanName, $options: "i" } });
      }
      if (!good) {
        // Determine category — map barcodeapp category name → iMach slug
        const bcatName = item.category?.name;
        let categoryId = jadidCat._id;
        let unit = "PIECE";
        if (bcatName && CAT_MAP[bcatName]) {
          const mappedCat = catBySlug.get(CAT_MAP[bcatName]);
          if (mappedCat) {
            categoryId = mappedCat._id;
            unit = mappedCat.unit || "PIECE";
          }
        }

        good = await db.collection('Good').insertOne({
          nameFa: cleanName,
          nameEn: null,
          aliases: [],
          searchText: goodSt,
          unit,
          categoryId: categoryId.toString(),
          hsCode: null,
          source: "SEED",
          status: "ACTIVE",
          creatorRole: "ADMIN",
          createdById: admin._id.toString(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        good = { _id: good.insertedId, nameFa: cleanName, categoryId: categoryId.toString(), unit };
        console.log(`  + Good created: ${cleanName} (cat: ${bcatName ? CAT_MAP[bcatName] || "jadid" : "jadid"})`);
      }

      // ── 3. Build attrs from parsed_attributes + weight + volume
      const attrs = {};
      if (item.metadata?.parsed_attributes) {
        for (const attr of item.metadata.parsed_attributes) {
          attrs[attr.name] = attr.value;
        }
      }
      if (item.weight_grams) attrs.weight_grams = String(item.weight_grams);
      if (item.metadata?.volume_ml) attrs.volume_ml = String(item.metadata.volume_ml);

      // ── 4. Build metadata (preserve everything valuable)
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
        barcodeapp_category: item.category?.name || null,
        barcodeapp_brand_id: item.brand_id || null,
        barcodeapp_category_id: item.category_id || null,
        imported_at: new Date().toISOString(),
      };

      // ── 5. Check for duplicate (same barcode or same brand+searchText)
      const searchText = normalizeFa(label);
      let existing = null;
      if (barcode) {
        existing = await db.collection('Product').findOne({ barcode, status: { $ne: "MERGED" } });
      }
      if (!existing) {
        existing = await db.collection('Product').findOne({
          goodId: good._id.toString(),
          brandId: brand._id.toString(),
          searchText,
          status: { $ne: "MERGED" },
        });
      }
      if (existing) {
        console.log(`  SKIP (duplicate): ${label}`);
        continue;
      }

      // ── 6. Create Product
      const product = await db.collection('Product').insertOne({
        goodId: good._id.toString(),
        brandId: brand._id.toString(),
        label,
        searchText,
        barcode: barcode || null,
        imageUrl,
        attrs: Object.keys(attrs).length > 0 ? attrs : null,
        metadata,
        status: "ACTIVE",
        creatorRole: "ADMIN",
        createdById: admin._id.toString(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      console.log(`  ✓ Product: ${label}`);
      console.log(`    barcode: ${barcode}`);
      console.log(`    brand: ${brandName}`);
      console.log(`    good: ${cleanName}`);
      console.log(`    image: ${imageUrl ? "✓" : "—"}`);
      console.log(`    attrs: ${JSON.stringify(attrs)}`);
      console.log(`    metadata: ${Object.keys(metadata).length} fields`);

      imported++;
    }

    page++;
    // Rate limit: wait 1 second between pages
    if (imported < limit && page <= Math.ceil(data.total / perPage)) {
      console.log("  (waiting 1s for rate limit...)");
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`\n=== Import complete ===`);
  console.log(`Imported: ${imported}`);
  console.log(`Total Brands: ${await db.collection('Brand').countDocuments()}`);
  console.log(`Total Goods: ${await db.collection('Good').countDocuments()}`);
  console.log(`Total Products: ${await db.collection('Product').countDocuments()}`);

  await client.close();
}
main().catch(e => { console.error(e); process.exit(1); });
