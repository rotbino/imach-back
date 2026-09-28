/**
 * Analyze cached data files: count items, check for missing pages, and report brand coverage.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = "/home/z/my-project/data";

function main() {
  const files = fs.readdirSync(DATA_DIR).filter(f => /^product-\d+\.json$/.test(f));
  console.log(`Cached files: ${files.length}`);

  // Get page numbers
  const pages = files.map(f => parseInt(f.match(/product-(\d+)\.json/)[1])).sort((a, b) => a - b);
  console.log(`Page range: ${pages[0]}..${pages[pages.length - 1]}`);

  // Find missing pages in range
  const pageSet = new Set(pages);
  const minPage = pages[0];
  const maxPage = pages[pages.length - 1];
  const missing = [];
  for (let p = minPage; p <= maxPage; p++) {
    if (!pageSet.has(p)) missing.push(p);
  }
  console.log(`Missing pages in range ${minPage}..${maxPage}: ${missing.length}`);
  if (missing.length > 0 && missing.length <= 50) {
    console.log(`Missing: ${missing.join(", ")}`);
  } else if (missing.length > 50) {
    console.log(`Missing (first 50): ${missing.slice(0, 50).join(", ")} ...`);
  }

  // Read page 1 to get total
  const first = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `product-1.json`)));
  const totalPages = Math.ceil(first.total / 20);
  console.log(`\nAPI says total pages: ${totalPages}`);
  console.log(`We have ${files.length}/${totalPages} pages (${(files.length / totalPages * 100).toFixed(1)}%)`);

  // Count items & brand coverage in cached data
  let totalItems = 0;
  let withBrand = 0;
  let withoutBrand = 0;
  let nullBrand = 0;
  let emptyBrandName = 0;
  const brandStats = {};
  const sampleNoBrand = [];

  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f)));
    for (const item of data.items) {
      totalItems++;
      const brand = item.brand;
      if (!brand) {
        nullBrand++;
        if (sampleNoBrand.length < 10) {
          sampleNoBrand.push({ page: f, id: item.id, name: item.name_fa, brand_id: item.brand_id });
        }
        continue;
      }
      if (!brand.name) {
        emptyBrandName++;
        if (sampleNoBrand.length < 10) {
          sampleNoBrand.push({ page: f, id: item.id, name: item.name_fa, brand_id: item.brand_id, brand_obj: brand });
        }
        continue;
      }
      withBrand++;
      const b = brand.name.trim();
      brandStats[b] = (brandStats[b] || 0) + 1;
    }
  }

  console.log(`\n=== Brand coverage in cached data ===`);
  console.log(`Total items: ${totalItems}`);
  console.log(`With brand name: ${withBrand} (${(withBrand / totalItems * 100).toFixed(1)}%)`);
  console.log(`Brand is null: ${nullBrand} (${(nullBrand / totalItems * 100).toFixed(1)}%)`);
  console.log(`Brand.name is empty: ${emptyBrandName} (${(emptyBrandName / totalItems * 100).toFixed(1)}%)`);

  if (sampleNoBrand.length > 0) {
    console.log(`\n=== Sample items WITHOUT brand ===`);
    for (const s of sampleNoBrand.slice(0, 5)) {
      console.log(`  ${s.name} (brand_id=${s.brand_id}, brand=${s.brand_obj ? JSON.stringify(s.brand_obj) : "null"})`);
    }
  }

  // Top 10 brands
  const topBrands = Object.entries(brandStats).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`\n=== Top 10 brands ===`);
  for (const [name, count] of topBrands) {
    console.log(`  ${name}: ${count}`);
  }

  console.log(`\nTotal unique brands: ${Object.keys(brandStats).length}`);
}

main();
