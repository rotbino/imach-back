/**
 * Fetch ALL products from barcodeapp.ir API — no filter, no skipping.
 *
 * Strategy:
 *   - Paginate /catalog/search?page=N&limit=100
 *   - Save each page → products-all/page-{N}.json
 *   - Continue until last page (total=42027, PER_PAGE=100 → 421 pages)
 *
 * Resumable: skips already-cached pages.
 * Concurrency: 3 workers with retry on 429.
 *
 * Usage: TOKEN="Bearer xxx" node fetch-all-products.js
 */
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TOKEN || "PLACEHOLDER_NEEDS_TOKEN";
const API_BASE = "https://api.barcodeapp.ir/catalog";
const DATA_DIR = "/home/z/imach-back/local-data";
const PRODUCTS_DIR = path.join(DATA_DIR, "products-all");

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

function pageFileName(page) {
  return path.join(PRODUCTS_DIR, `page-${page}.json`);
}

function isPageCached(page) {
  return fs.existsSync(pageFileName(page));
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

async function main() {
  if (TOKEN === "PLACEHOLDER_NEEDS_TOKEN") {
    console.error("ERROR: pass TOKEN env var.");
    process.exit(1);
  }

  const startTime = Date.now();
  logEvent("INFO", "=== Fetch ALL products (no filter) starting ===");

  // Fetch page 1 to get total (or use cached)
  let total;
  if (isPageCached(1)) {
    const cached = JSON.parse(fs.readFileSync(pageFileName(1), 'utf8'));
    total = cached.total;
    logEvent("INFO", `Page 1 cached. Total: ${total}`);
  } else {
    logEvent("INFO", "Fetching page 1...");
    const r = await fetchWithRetry(`${API_BASE}/search?page=1&limit=${PER_PAGE}`, "page 1");
    if (!r.ok) {
      logEvent("FATAL", "Failed to fetch first page");
      fs.writeFileSync(path.join(DATA_DIR, "fetch-all-log.json"), JSON.stringify(log, null, 2));
      process.exit(2);
    }
    fs.writeFileSync(pageFileName(1), JSON.stringify(r.data, null, 2));
    total = r.data.total;
    logEvent("INFO", `Page 1 saved. Total items: ${total}`);
  }

  const totalPages = Math.ceil(total / PER_PAGE);
  logEvent("INFO", `Total pages: ${totalPages}`);

  // Build list of pages to fetch (skip cached)
  const pagesToFetch = [];
  for (let p = 1; p <= totalPages; p++) {
    if (!isPageCached(p)) pagesToFetch.push(p);
  }
  logEvent("INFO", `Need to fetch ${pagesToFetch.length}/${totalPages} pages (skipping ${totalPages - pagesToFetch.length} cached)`);

  let idx = 0;
  let done = 0;
  const failedPages = new Set();

  async function worker(workerId) {
    while (idx < pagesToFetch.length) {
      const page = pagesToFetch[idx++];
      await new Promise(r => setTimeout(r, INTER_REQUEST_MS));
      const url = `${API_BASE}/search?page=${page}&limit=${PER_PAGE}`;
      const r = await fetchWithRetry(url, `page ${page}`);
      if (r.ok) {
        fs.writeFileSync(pageFileName(page), JSON.stringify(r.data, null, 2));
        done++;
        if (done % 20 === 0 || done === pagesToFetch.length) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const rate = (done / elapsed).toFixed(2);
          const remaining = Math.ceil((pagesToFetch.length - done) / rate);
          logEvent("INFO", `[${done}/${pagesToFetch.length}] Page ${page} ✓ (${rate} pg/s, ${elapsed}s elapsed, ~${remaining}s left)`);
        }
      } else {
        if (r.fatal) {
          logEvent("FATAL", "Token expired — stopping.");
          fs.writeFileSync(path.join(DATA_DIR, "fetch-all-log.json"), JSON.stringify(log, null, 2));
          process.exit(2);
        }
        logEvent("ERROR", `Page ${page} failed permanently`);
        failedPages.add(page);
      }
    }
  }

  await Promise.all(Array.from({length: CONCURRENCY}, (_, i) => worker(i+1)));

  // Final summary
  const summary = {
    timestamp: new Date().toISOString(),
    duration_seconds: Math.round((Date.now() - startTime) / 1000),
    total_items: total,
    total_pages: totalPages,
    pages_fetched: done,
    failed_pages: Array.from(failedPages).sort((a, b) => a - b),
    cached_dir: PRODUCTS_DIR,
  };
  fs.writeFileSync(path.join(DATA_DIR, "fetch-all-summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, "fetch-all-log.json"), JSON.stringify(log, null, 2));

  logEvent("INFO", `=== Fetch complete ===`);
  logEvent("INFO", `Duration: ${summary.duration_seconds}s`);
  logEvent("INFO", `Pages fetched: ${done}/${pagesToFetch.length}`);
  logEvent("INFO", `Failed pages: ${failedPages.size}`);
  if (failedPages.size > 0) {
    logEvent("WARN", `Failed: ${Array.from(failedPages).sort((a,b) => a-b).slice(0, 20).join(", ")}${failedPages.size > 20 ? "..." : ""}`);
  }
}

main().catch(e => {
  logEvent("FATAL", `Unhandled: ${e.message}`);
  console.error(e);
  fs.writeFileSync(path.join(DATA_DIR, "fetch-all-log.json"), JSON.stringify(log, null, 2));
  process.exit(1);
});
