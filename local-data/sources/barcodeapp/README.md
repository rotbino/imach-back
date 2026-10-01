# barcodeapp.ir — Source Data & Scripts

## Reference Catalog
- **reference-catalog-v3.json** — 370 standard goods (نوع کالا) covering all supermarket categories
  - Each good is a distinct product TYPE (e.g., "لوبیا چیتی", "پسته", "شیر پرچرب")
  - Built from: GS1 GPC + Iranian market knowledge + analysis of 42,000 real products
  - Used by rebuild-goods.js to replace legacy goods in iMach DB

## Data
- **products-merged.json.gz** — All 42,027 products from barcodeapp.ir API
- **categories.json** — 272 barcodeapp categories
- **brands.json** — 1,144 brands from API
- **backup-goods-before-rebuild.json** — Backup of original 12,568 goods (before rebuild)

## Scripts (pipeline order)
1. **fetch-all-products.js** — Fetch all 421 pages from barcodeapp API
2. **extract-brands-v3.js** — Extract brands from product names (adds 114 discovered brands)
3. **import-final-v2.js** — Import products to MongoDB (brands → goods → products)
4. **reclassify-goods-bulk.js** — Fix jadid-classified goods using taxonomy
5. **build-detailed-catalog.js** — Generate reference catalog of 351 standard goods
6. **patch-catalog.js** — Patch catalog: split combined goods, add missing types, fix keywords
7. **rebuild-goods.js** — Replace legacy goods with reference goods + reassign all products

## Key Files
- **reference-catalog-v3.json** is the SOURCE OF TRUTH for the Good table
- Each good has: slug, nameFa, nameEn, aliases, keywords, excludeKeywords, gs1GpcCode, hsCode, unit, categoryId, attrs
