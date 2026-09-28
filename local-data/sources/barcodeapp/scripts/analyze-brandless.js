/**
 * Show samples of items without brand, organized by source.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = "/home/z/my-project/data";

function main() {
  const bySource = {};
  const brandlessSamples = {};

  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!/^product-\d+\.json$/.test(f)) continue;
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f)));
    for (const item of data.items) {
      const src = item.source || "unknown";
      bySource[src] = (bySource[src] || 0) + 1;

      if (!item.brand || !item.brand.name) {
        if (!brandlessSamples[src]) brandlessSamples[src] = [];
        if (brandlessSamples[src].length < 5) {
          brandlessSamples[src].push({
            name_fa: item.name_fa,
            barcode: item.barcode,
            metadata: item.metadata,
            category: item.category,
            source_taxonomy: item.metadata?.source_taxonomy,
          });
        }
      }
    }
  }

  console.log("=== Item counts by source ===");
  for (const [src, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${src}: ${count}`);
  }

  console.log("\n=== Sample brandless items by source ===");
  for (const [src, samples] of Object.entries(brandlessSamples)) {
    console.log(`\n--- source: ${src} ---`);
    for (const s of samples.slice(0, 3)) {
      console.log(`  name: ${s.name_fa}`);
      console.log(`  barcode: ${s.barcode}`);
      if (s.source_taxonomy) {
        console.log(`  category: ${s.source_taxonomy.category} / ${s.source_taxonomy.subcategory}`);
      }
      if (s.category) {
        console.log(`  item.category: ${JSON.stringify(s.category)}`);
      }
      // Check parsed_brand
      const pb = s.metadata?.parsed_brand;
      if (pb) {
        console.log(`  parsed_brand: ${JSON.stringify(pb)}`);
      }
    }
  }
}

main();
