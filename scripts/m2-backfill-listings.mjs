#!/usr/bin/env node
/**
 * iMach — M2 backfill: Listing v2 fields (idempotent)
 * ------------------------------------------------------------
 * Fills the NEW nullable fields on every Listing row (44 at M2 baseline):
 *   • baseQty           — parsed from attrs.weight («50kg» → 50)
 *   • pricePerBaseMinor — floor(priceMinor ÷ baseQty)  (C1 normal price)
 *   • title             — from variantLabel (only when title is null — C6)
 *   • pricedAt          — updatedAt as the initial pricing stamp (G7)
 *
 * Safe to re-run: every field is written only when currently null/undefined.
 * Red-line tables (Good/Brand/Product/Category/Unit) are NEVER touched.
 *
 * Usage:
 *   node scripts/m2-backfill-listings.mjs <mongo-uri>
 */
import { MongoClient } from "mongodb";

const uri = process.argv[2];
if (!uri) {
  console.error("✖ Usage: node scripts/m2-backfill-listings.mjs <mongo-uri>");
  process.exit(1);
}

/** «50kg» / «500g» / «10KG» → 50 / 0.5 / 10 — null when unparseable */
function parseWeightToBaseQty(attrs) {
  if (!attrs) return null;
  const w = attrs.weight ?? attrs.w ?? attrs["وزن"];
  if (typeof w !== "string") return null;
  const m = w.trim().match(/^(\d+(?:\.\d+)?)\s*(kg|KILOGRAM|کیلو(?:گرم)?|g|گرم|gr)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "kg").toLowerCase();
  // Good.unit is the base; attrs.weight historically encodes kg values →
  // grams convert to kg (0.5), everything else passes through as the count.
  if (unit === "g" || unit === "گرم" || unit === "gr") return n / 1000;
  return n;
}

const c = new MongoClient(uri);
await c.connect();
const db = c.db();
const col = db.collection("Listing");

const rows = await col.find({}, { projection: { attrs: 1, variantLabel: 1, priceMinor: 1, title: 1, baseQty: 1, pricePerBaseMinor: 1, pricedAt: 1, updatedAt: 1 } }).toArray();
console.log(`Listing rows: ${rows.length}`);

let nBase = 0, nPer = 0, nTitle = 0, nStamp = 0;
for (const r of rows) {
  const set = {};

  if (r.baseQty === undefined || r.baseQty === null) {
    const q = parseWeightToBaseQty(r.attrs);
    if (q !== null) {
      set.baseQty = q;
      nBase++;
    }
  }
  const baseQty = set.baseQty ?? r.baseQty ?? null;
  if ((r.pricePerBaseMinor === undefined || r.pricePerBaseMinor === null) && typeof r.priceMinor === "number" && baseQty && baseQty > 0) {
    set.pricePerBaseMinor = Math.floor(r.priceMinor / baseQty);
    nPer++;
  }
  if ((r.title === undefined || r.title === null) && typeof r.variantLabel === "string" && r.variantLabel.trim()) {
    set.title = r.variantLabel.trim().slice(0, 120);
    nTitle++;
  }
  if (r.pricedAt === undefined || r.pricedAt === null) {
    set.pricedAt = r.updatedAt ?? new Date();
    nStamp++;
  }

  if (Object.keys(set).length > 0) {
    await col.updateOne({ _id: r._id }, { $set: set });
  }
}

console.log(`✔ baseQty set on ${nBase} rows · pricePerBaseMinor on ${nPer} · title on ${nTitle} · pricedAt on ${nStamp}`);
await c.close();
