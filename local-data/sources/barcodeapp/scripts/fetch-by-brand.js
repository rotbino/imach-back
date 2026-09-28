/**
 * Fetch all products from barcodeapp.ir, grouped by brand.
 *
 * Strategy:
 *   1. Read brands.json (already fetched — 1,144 brands)
 *   2. For each brand, paginate /catalog/search?brand_id=X&page=N&limit=100
 *   3. Save each page → products-by-brand/brand-{brandId}-page-{N}.json
 *
 * Resumable: skips already-fetched brands and pages.
 * Concurrency: 3 parallel workers (low to avoid 429).
 *
 * Usage: TOKEN="Bearer xxx" node fetch-by-brand.js [--start=N]
 */
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TOKEN || "PLACEHOLDER_NEEDS_TOKEN";
const API_BASE = "https://api.barcodeapp.ir/catalog";
const DATA_DIR = "/home/z/imach-back/local-data";
const PRODUCTS_DIR = path.join(DATA_DIR, "products-by-brand");

const CONCURRENCY = 3;
const PER_PAGE = 100;
const MAX_RETRIES = 4;
const RETRY_BASE_MS = 3000;
const INTER_REQUEST_MS = 250;

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

function brandFileName(brandId, page) {
  return path.join(PRODUCTS_DIR, `brand-${brandId}-page-${page}.json`);
}

function isBrandPageCached(brandId, page) {
  return fs.existsSync(brandFileName(brandId, page));
}

function getBrandCachedPages(brandId) {
  const prefix = `brand-${brandId}-page-`;
  return fs.readdirSync(PRODUCTS_DIR)
    .filter(f => f.startsWith(prefix))
    .map(f => parseInt(f.slice(prefix.length, -5)))
    .sort((a, b) => a - b);
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
      if (res.ok) return { ok: true, data: await res.json() };
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

async function fetchBrandPage(brandId, page) {
  const url = `${API_BASE}/search?page=${page}&limit=${PER_PAGE}&brand_id=${brandId}`;
  return fetchWithRetry(url, `brand ${shortId(brandId)} page ${page}`);
}

async function fetchAllProductsForBrand(brand) {
  // Check what pages we already have
  const cachedPages = getBrandCachedPages(brand.id);
  let firstMissingPage = 1;
  if (cachedPages.length > 0) {
    // Find the first missing page after the highest cached
    const maxCached = cachedPages[cachedPages.length - 1];
    // Try to find first gap or next page after max
    const cachedSet = new Set(cachedPages);
    while (cachedSet.has(firstMissingPage)) firstMissingPage++;
    if (firstMissingPage > maxCached) {
      // We have all pages up to maxCached, check if there's more
      const lastData = JSON.parse(fs.readFileSync(brandFileName(brand.id, maxCached), 'utf8'));
      const totalPages = Math.ceil((lastData.total || 0) / PER_PAGE);
      if (maxCached >= totalPages) {
        return { skipped: true, pages: maxCached };
      }
    }
  }

  // Fetch the first missing page to get total
  const firstResult = await fetchBrandPage(brand.id, firstMissingPage);
  if (!firstResult.ok) {
    if (firstResult.fatal) process.exit(2);
    return { failed: true };
  }
  const total = firstResult.data.total || 0;
  const totalPages = Math.ceil(total / PER_PAGE);
  fs.writeFileSync(brandFileName(brand.id, firstMissingPage), JSON.stringify(firstResult.data, null, 2));

  if (totalPages <= 1) {
    return { pages: 1, items: firstResult.data.items.length, total };
  }

  // Build list of remaining pages
  const remainingPages = [];
  for (let p = firstMissingPage + 1; p <= totalPages; p++) {
    if (!isBrandPageCached(brand.id, p)) remainingPages.push(p);
  }

  let savedPages = 1;
  let idx = 0;
  async function worker(workerId) {
    while (idx < remainingPages.length) {
      const page = remainingPages[idx++];
      await new Promise(r => setTimeout(r, INTER_REQUEST_MS));
      const r = await fetchBrandPage(brand.id, page);
      if (r.ok) {
        fs.writeFileSync(brandFileName(brand.id, page), JSON.stringify(r.data, null, 2));
        savedPages++;
      } else {
        if (r.fatal) process.exit(2);
        logEvent("ERROR", `[${brand.name}] page ${page} failed permanently`);
      }
    }
  }
  await Promise.all(Array.from({length: Math.min(CONCURRENCY, remainingPages.length)}, (_, i) => worker(i+1)));

  return { pages: totalPages, items: total };
}

async function main() {
  if (TOKEN === "PLACEHOLDER_NEEDS_TOKEN") {
    console.error("ERROR: pass TOKEN env var.");
    process.exit(1);
  }

  const startIdx = parseInt(process.argv.find(a => a.startsWith("--start="))?.split("=")[1] || "1") - 1;

  const startTime = Date.now();
  logEvent("INFO", "=== Fetch by brand starting ===");

  // Read brands
  const brands = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "brands.json"), 'utf8')).brands;
  logEvent("INFO", `Total brands: ${brands.length}`);

  // Sort by count desc so we tackle biggest brands first
  brands.sort((a, b) => b.count - a.count);
  logEvent("INFO", `Top brand: ${brands[0].name} with ${brands[0].count} products`);

  const results = [];
  let processed = 0;
  let totalItemsFetched = 0;

  for (let i = startIdx; i < brands.length; i++) {
    const brand = brands[i];
    processed++;
    logEvent("INFO", `Brand ${processed}/${brands.length}: ${brand.name} (${brand.count} items, id=${shortId(brand.id)})`);
    const r = await fetchAllProductsForBrand(brand);
    results.push({ brandId: brand.id, name: brand.name, expectedCount: brand.count, ...r });
    if (r.items) totalItemsFetched += r.items;

    if (processed % 10 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (processed / elapsed).toFixed(2);
      logEvent("INFO", `Progress: ${processed}/${brands.length} brands, ${totalItemsFetched} items, ${elapsed}s (${rate} brands/s)`);
    }

    // Periodically save log
    if (processed % 50 === 0) {
      fs.writeFileSync(path.join(DATA_DIR, "fetch-by-brand-log.json"), JSON.stringify(log, null, 2));
    }
  }

  // Final summary
  const summary = {
    timestamp: new Date().toISOString(),
    duration_seconds: Math.round((Date.now() - startTime) / 1000),
    brands_processed: processed,
    total_items_fetched: totalItemsFetched,
    per_brand: results,
  };
  fs.writeFileSync(path.join(DATA_DIR, "fetch-by-brand-summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, "fetch-by-brand-log.json"), JSON.stringify(log, null, 2));

  logEvent("INFO", `=== Fetch complete ===`);
  logEvent("INFO", `Duration: ${summary.duration_seconds}s`);
  logEvent("INFO", `Brands processed: ${processed}`);
  logEvent("INFO", `Total items fetched: ${totalItemsFetched}`);
}

main().catch(e => {
  logEvent("FATAL", `Unhandled: ${e.message}`);
  console.error(e);
  fs.writeFileSync(path.join(DATA_DIR, "fetch-by-brand-log.json"), JSON.stringify(log, null, 2));
  process.exit(1);
});
