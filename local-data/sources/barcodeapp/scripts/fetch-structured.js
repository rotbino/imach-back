/**
 * Structured fetcher for barcodeapp.ir — saves all data as organized JSON files.
 *
 * Strategy:
 *   1. Fetch /catalog/categories  (single request → categories.json)
 *   2. Fetch /catalog/brands     (single request → brands.json, returns all brands at once)
 *   3. For each category with count > 0:
 *      - Paginate /catalog/search?category_id=X&page=N&limit=100
 *      - Save each page → products-cat-{catId}-page-{N}.json
 *      - Also save aggregated → products-cat-{catId}-all.json
 *
 * Output structure (in DATA_DIR):
 *   ├── categories.json
 *   ├── brands.json
 *   ├── catalog-summary.json
 *   ├── products/
 *   │   ├── cat-{categoryId}-page-1.json
 *   │   ├── cat-{categoryId}-page-2.json
 *   │   └── ...
 *   └── fetch-log.json
 *
 * Usage: TOKEN="Bearer xxx" node fetch-structured.js [--categories-only] [--brands-only] [--resume]
 *
 * Features:
 *   - Resumable: skips already-fetched categories and pages
 *   - Concurrency: 3 parallel workers (low to avoid 429)
 *   - Retry with exponential backoff on 429
 *   - Catches token expiry (401) and stops gracefully
 */
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TOKEN || "PLACEHOLDER_NEEDS_TOKEN";
const API_BASE = "https://api.barcodeapp.ir/catalog";
const DATA_DIR = "/home/z/imach-back/local-data";
const PRODUCTS_DIR = path.join(DATA_DIR, "products");

const CONCURRENCY = 3;
const PER_PAGE = 100;
const MAX_RETRIES = 4;
const RETRY_BASE_MS = 3000;
const INTER_REQUEST_MS = 250;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PRODUCTS_DIR, { recursive: true });

const headers = {
  "Authorization": `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
  "Origin": "https://app.barcodeapp.ir",
  "Referer": "https://app.barcodeapp.ir/",
  "User-Agent": "Mozilla/5.0",
  "x-app-platform": "direct",
  "x-app-version": "1.1.56",
  "x-store-id": "93431765-e3b9-47b0-8652-f69267c89714",
};

function shortId(id) {
  return id ? id.substring(0, 8) : "unknown";
}

function catFileName(catId, page) {
  return path.join(PRODUCTS_DIR, `cat-${catId}-page-${page}.json`);
}

function isPageCached(catId, page) {
  return fs.existsSync(catFileName(catId, page));
}

const log = [];
function logEvent(level, msg) {
  const entry = { ts: new Date().toISOString(), level, msg };
  log.push(entry);
  console.log(`[${entry.ts.split('T')[1].slice(0,8)}] ${level}: ${msg}`);
}

async function fetchWithRetry(url, label = "") {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) {
        return { ok: true, data: await res.json() };
      }
      if (res.status === 401 || res.status === 403) {
        logEvent("FATAL", `Auth failed (${res.status}) on ${label} — token expired.`);
        return { ok: false, fatal: true, status: res.status };
      }
      if (res.status === 429) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
        logEvent("WARN", `429 on ${label} — retry ${attempt+1}/${MAX_RETRIES} after ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      const delay = 1500 * (attempt + 1);
      logEvent("WARN", `${res.status} on ${label} — retry ${attempt+1}/${MAX_RETRIES} after ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    } catch (e) {
      logEvent("WARN", `ERR on ${label} attempt ${attempt+1}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return { ok: false, fatal: false };
}

async function fetchCategories() {
  const cacheFile = path.join(DATA_DIR, "categories.json");
  if (fs.existsSync(cacheFile)) {
    logEvent("INFO", "categories.json exists, skipping fetch.");
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8')).categories;
  }
  logEvent("INFO", "Fetching /catalog/categories ...");
  const r = await fetchWithRetry(`${API_BASE}/categories`, "categories");
  if (!r.ok) { logEvent("FATAL", "Failed to fetch categories"); process.exit(2); }
  fs.writeFileSync(cacheFile, JSON.stringify(r.data, null, 2));
  logEvent("INFO", `Saved ${r.data.categories.length} categories.`);
  return r.data.categories;
}

async function fetchBrands() {
  const cacheFile = path.join(DATA_DIR, "brands.json");
  if (fs.existsSync(cacheFile)) {
    logEvent("INFO", "brands.json exists, skipping fetch.");
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8')).brands;
  }
  logEvent("INFO", "Fetching /catalog/brands ...");
  const r = await fetchWithRetry(`${API_BASE}/brands?page=1&limit=2000`, "brands");
  if (!r.ok) { logEvent("FATAL", "Failed to fetch brands"); process.exit(2); }
  fs.writeFileSync(cacheFile, JSON.stringify(r.data, null, 2));
  logEvent("INFO", `Saved ${r.data.brands.length} brands.`);
  return r.data.brands;
}

async function fetchCategoryPage(catId, page) {
  const url = `${API_BASE}/search?page=${page}&limit=${PER_PAGE}&category_id=${catId}`;
  return fetchWithRetry(url, `cat ${shortId(catId)} page ${page}`);
}

async function fetchAllProductsForCategory(cat) {
  // First check what pages we already have
  let firstMissingPage = 1;
  while (isPageCached(cat.id, firstMissingPage)) firstMissingPage++;

  if (firstMissingPage > 1) {
    // Read the last cached page to get total
    const lastCached = JSON.parse(fs.readFileSync(catFileName(cat.id, firstMissingPage - 1), 'utf8'));
    const totalPages = Math.ceil((lastCached.total || 0) / PER_PAGE);
    if (firstMissingPage > totalPages) {
      return { skipped: true, pages: firstMissingPage - 1 };
    }
  }

  // Fetch the first missing page (or first page) to get total
  const firstResult = await fetchCategoryPage(cat.id, firstMissingPage);
  if (!firstResult.ok) {
    if (firstResult.fatal) process.exit(2);
    return { failed: true };
  }
  const total = firstResult.data.total || 0;
  const totalPages = Math.ceil(total / PER_PAGE);
  fs.writeFileSync(catFileName(cat.id, firstMissingPage), JSON.stringify(firstResult.data, null, 2));

  if (totalPages <= 1) {
    logEvent("INFO", `[${cat.name}] ${firstResult.data.items.length} items (1 page)`);
    return { pages: 1, items: firstResult.data.items.length };
  }

  // Build list of remaining pages
  const remainingPages = [];
  for (let p = firstMissingPage + 1; p <= totalPages; p++) {
    if (!isPageCached(cat.id, p)) remainingPages.push(p);
  }

  let savedPages = 1;
  let idx = 0;
  async function worker(workerId) {
    while (idx < remainingPages.length) {
      const page = remainingPages[idx++];
      await new Promise(r => setTimeout(r, INTER_REQUEST_MS));
      const r = await fetchCategoryPage(cat.id, page);
      if (r.ok) {
        fs.writeFileSync(catFileName(cat.id, page), JSON.stringify(r.data, null, 2));
        savedPages++;
        if (savedPages % 5 === 0 || savedPages === remainingPages.length) {
          logEvent("INFO", `[${cat.name}] ${savedPages}/${remainingPages.length} pages saved`);
        }
      } else {
        if (r.fatal) process.exit(2);
        logEvent("ERROR", `[${cat.name}] page ${page} failed permanently`);
      }
    }
  }
  await Promise.all(Array.from({length: CONCURRENCY}, (_, i) => worker(i+1)));

  return { pages: totalPages, items: total };
}

async function main() {
  if (TOKEN === "PLACEHOLDER_NEEDS_TOKEN") {
    console.error("ERROR: pass TOKEN env var. Example: TOKEN='Bearer xxx' node fetch-structured.js");
    process.exit(1);
  }
  const catsOnly = process.argv.includes("--categories-only");
  const brandsOnly = process.argv.includes("--brands-only");
  const resume = process.argv.includes("--resume");

  const startTime = Date.now();
  logEvent("INFO", "=== Structured fetch starting ===");

  // Step 1: categories
  const categories = await fetchCategories();
  logEvent("INFO", `Total categories: ${categories.length}`);

  // Step 2: brands
  const brands = await fetchBrands();
  logEvent("INFO", `Total brands: ${brands.length}`);

  if (catsOnly || brandsOnly) {
    logEvent("INFO", "Categories/brands only — exiting.");
    fs.writeFileSync(path.join(DATA_DIR, "fetch-log.json"), JSON.stringify(log, null, 2));
    return;
  }

  // Step 3: products per category
  // Sort by count desc so we tackle biggest first
  const sortedCats = categories
    .filter(c => c.count && c.count > 0)
    .sort((a, b) => b.count - a.count);

  logEvent("INFO", `Will fetch products for ${sortedCats.length} categories with count > 0`);
  const sumOfCounts = sortedCats.reduce((s, c) => s + c.count, 0);
  logEvent("INFO", `Sum of category counts: ${sumOfCounts} (note: items can be in multiple categories)`);

  const results = [];
  let processed = 0;
  for (const cat of sortedCats) {
    processed++;
    logEvent("INFO", `Category ${processed}/${sortedCats.length}: ${cat.name} (${cat.count} items, id=${shortId(cat.id)})`);
    const r = await fetchAllProductsForCategory(cat);
    results.push({ categoryId: cat.id, name: cat.name, expectedCount: cat.count, ...r });
    if (processed % 10 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logEvent("INFO", `Progress: ${processed}/${sortedCats.length} categories, ${elapsed}s elapsed`);
    }
  }

  // Final summary
  const summary = {
    timestamp: new Date().toISOString(),
    duration_seconds: Math.round((Date.now() - startTime) / 1000),
    categories_count: categories.length,
    categories_with_products: sortedCats.length,
    brands_count: brands.length,
    sum_of_category_counts: sumOfCounts,
    per_category: results,
  };
  fs.writeFileSync(path.join(DATA_DIR, "catalog-summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, "fetch-log.json"), JSON.stringify(log, null, 2));

  logEvent("INFO", `=== Fetch complete ===`);
  logEvent("INFO", `Duration: ${summary.duration_seconds}s`);
  logEvent("INFO", `Categories with products: ${sortedCats.length}`);
  logEvent("INFO", `Files saved in: ${DATA_DIR}/products/`);
}

main().catch(e => {
  logEvent("FATAL", `Unhandled: ${e.message}`);
  console.error(e);
  fs.writeFileSync(path.join(DATA_DIR, "fetch-log.json"), JSON.stringify(log, null, 2));
  process.exit(1);
});
