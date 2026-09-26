/**
 * ─── Import file parser ──────────────────────────────────────────────────────
 * «همه‌ی قالب‌ها قبول شود، خودکار تشخیص بده» (خواسته‌ی کاربر) — فایلِ اکسل/CSV
 * خرده‌فروش همان‌طور که هست خوانده می‌شود:
 *   • سرستون‌ها فازی شناسایی می‌شوند: مترادف فارسی/انگلیسی + «شامل» (ستونِ
 *     «نام کالا (واحد)» هم همان «نام کالا» است) + نیم‌فاصله/فاصله بی‌اثر.
 *   • CSV با هر انکودینگی که اکسل فارسی می‌سازد باز می‌شود: UTF-8، UTF-16،
 *     و ANSI ویندوز (cp1256) — CSV فارسیِ re-save شده دیگر خراب نمی‌شود.
 *   • فایلِ بی‌سرستون هم می‌آید: ستون‌ها از رفتار داده حدس زده می‌شوند (ستون
 *     متن‌اول = نام، ستون عددِ بزرگ = قیمت…) و حدس در پیش‌نمایش دیده می‌شود.
 *   • هر دو بازو در یک فایل: «قیمت فروش» → SELL، «حجم خرید» → BUY، هر دو →
 *     BOTH؛ برند خالی = بدون برند (خواسته‌ی کاربر: بدون ابهام).
 */

import * as XLSX from "xlsx";

export interface ImportRow {
  index: number; // 1-based row number as the user sees it in their file
  name: string;
  brand: string;
  spec: string;
  priceMinor: number | null; // sell price in rial-minor
  stock: number | null;
  minOrder: number | null;
  volume: number | null; // buy volume
  imageUrl: string | null;
  /** نام دسته اصلی (مثلاً «مواد غذایی») — اختیاری، برای ساخت Good در دسته درست */
  category: string;
  /** نام زیردسته (مثلاً «تن ماهی») — اختیاری، اگر خالی بود Good در دسته اصلی */
  subcategory: string;
}

/** Loose shape accepted by the service — DTO rows (optional fields) fit in. */
export type ImportRowInput = {
  index: number;
  name: string;
  brand?: string | null;
  spec?: string | null;
  priceMinor?: number | null;
  stock?: number | null;
  minOrder?: number | null;
  volume?: number | null;
  imageUrl?: string | null;
  category?: string | null;
  subcategory?: string | null;
};

/**
 * Persian/English header synonyms — exact-normalized match wins. Matching is
 * done on the SAME normalizer as the cells (ZWNJ → space, collapsed spaces,
 * lowercase) and falls back to «cell contains synonym» so decorated headers
 * like «نام کالا (مثلا شیر)» or «قیمت فروش (تومان)» still land.
 */
const HEADER_SYNONYMS: Record<string, string[]> = {
  name: [
    "نام کالا", "نام محصول", "نام جنس", "شرح کالا", "شرح", "عنوان کالا", "عنوان", "کالا",
    "محصول", "جنس", "نام", "product", "product name", "name", "item", "title", "description",
  ],
  brand: ["برند", "مارک", "سازنده", "کمپانی", "شرکت سازنده", "brand", "manufacturer", "company"],
  spec: [
    "بسته بندی", "ویژگی", "مشخصات", "وزن", "اندازه", "گرام", "سایز", "حجم بسته",
    "spec", "size", "pack", "packaging", "weight", "variant",
  ],
  priceMinor: [
    "قیمت فروش", "قیمت واحد", "قیمت هر واحد", "قیمت عمده", "قیمت نقد", "قیمت (تومان)",
    "قیمت", "نرخ", "مبلغ", "price", "unit price", "sale price", "selling price", "rate", "amount",
  ],
  stock: ["موجودی", "تعداد موجود", "تعداد", "شماره موجودی", "stock", "qty", "quantity", "inventory"],
  minOrder: ["حداقل سفارش", "حداقل سفارش خرید", "حداقل", "min order", "moq", "minimum order"],
  volume: ["حجم خرید", "حجم", "مقدار خرید", "مقدار", "volume", "buy volume", "purchase volume", "amount"],
  imageUrl: ["لینک عکس", "آدرس عکس", "عکس", "تصویر", "لینک تصویر", "image", "image url", "photo", "picture", "img"],
  category: ["دسته", "دسته اصلی", "گروه کالا", "گروه اصلی", "category", "group", "department"],
  subcategory: ["زیردسته", "زیر دسته", "دسته فرعی", "زیرگروه", "subcategory", "sub group", "sub category"],
};

const MAX_IMPORT_ROWS = 2000;
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

/** Convert Persian/Arabic digits to ASCII and keep digits only. */
function digitsOnly(s: string): string {
  return s
    .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[^\d]/g, "");
}

function toIntOrNull(v: unknown): number | null {
  const s = digitsOnly(String(v ?? ""));
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** decimal-safe parse for volume («۱.۵» / «1,5» / «۱/۵») */
function toFloatOrNull(v: unknown): number | null {
  const s = String(v ?? "")
    .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[٫,\/]/g, ".")
    .replace(/[^\d.]/g, "");
  if (!s || s === ".") return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normHeader(s: unknown): string {
  return String(s ?? "")
    .replace(/\u200C/g, " ")
    // تاشدگی‌های فارسی — گیرنده‌ی انکودینگ cp1256 در بعضی محیط‌ها ى/ی را
    // جابه‌جا می‌دهد؛ یکسان‌سازی این‌ها تطبیق سرستون را مستقل از ICU می‌کند
    .replace(/[يكى]/g, (c) => (c === "ك" ? "ک" : "ی"))
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Bounded URL sanity — nothing fancy, just reject non-http and obvious junk. */
function toUrlOrNull(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s || s.length > 500) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Decode a CSV buffer the way Persian Excel actually produces them:
 * UTF-8 BOM → utf-8; UTF-16 BOM → utf-16; then valid utf-8; then windows-1256
 * (Excel «CSV (Windows)» re-save garbles Persian into ANSI — this undoes it).
 */
function decodeSheetBuffer(buffer: Buffer): string {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer);
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder("utf-16be").decode(buffer);
  }
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  if (!utf8.includes("\uFFFD")) return utf8.replace(/^\uFEFF/, "");
  // replacement chars → the bytes were NOT utf-8; Persian Windows ANSI
  try {
    return new TextDecoder("windows-1256").decode(buffer);
  } catch {
    return utf8;
  }
}

/** Read the first sheet of (xlsx | xls | csv | txt) into a raw cell grid. */
function readGrid(buffer: Buffer): unknown[][] {
  const isText =
    // heuristic: CSV/text files rarely start with the zip/OLE magics
    !(buffer[0] === 0x50 && buffer[1] === 0x4b) && !(buffer[0] === 0xd0 && buffer[1] === 0xcf);
  if (isText) {
    const text = decodeSheetBuffer(buffer);
    const wb = XLSX.read(text, { type: "string", raw: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return [];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", blankrows: false });
  }
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", blankrows: false });
}

interface ColumnMap {
  colOf: Map<string, number>;
  /** how the columns were found — surfaced in the preview for trust */
  detected: "header" | "guess";
}

/** Score a row as header: distinct synonym fields matched (normalized contains). */
function matchHeaderRow(cells: string[]): Map<string, number> {
  const found = new Map<string, number>();
  for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    let best = -1;
    let bestLen = 0;
    cells.forEach((c, idx) => {
      if (!c || found.has(field)) return;
      for (const s of synonyms) {
        if (bestLen >= s.length) continue; // longer synonym = more specific
        if (c === s || (s.length >= 4 && c.includes(s))) {
          best = idx;
          bestLen = s.length;
        }
      }
    });
    if (best >= 0) found.set(field, best);
  }
  return found;
}

/**
 * Headerless files still deserve to come in (خواسته‌ی کاربر: «همه قالب‌ها»).
 * Behavioral guess from the data itself: the first mostly-text column is the
 * name; among numeric columns the one with the largest median is the price;
 * the other numeric is stock. The preview shows the guess — nothing is saved
 * unseen, so a wrong guess is fixable at a glance.
 */
function guessColumns(grid: string[][]): ColumnMap {
  const width = Math.max(...grid.slice(0, 50).map((r) => r.length), 0);
  if (width === 0) return { colOf: new Map(), detected: "guess" };
  const stats = Array.from({ length: width }, (_, c) => {
    const cells = grid.slice(0, 50).map((r) => (r[c] ?? "").trim()).filter(Boolean);
    const numeric = cells.filter((v) => digitsOnly(v) === v.replace(/[٫,]/g, "")).length;
    const avgLen = cells.reduce((a, v) => a + v.length, 0) / Math.max(cells.length, 1);
    const values = cells.map((v) => Number(digitsOnly(v) || "0")).sort((a, b) => a - b);
    const median = values.length ? values[Math.floor(values.length / 2)] : 0;
    return { c, numeric, avgLen, median, samples: cells.length };
  });
  const nameCol =
    stats.find((s) => s.samples > 0 && s.numeric / Math.max(s.samples, 1) < 0.2 && s.avgLen >= 3)?.c ?? 0;
  const numericCols = stats
    .filter((s) => s.samples > 0 && s.numeric / Math.max(s.samples, 1) >= 0.8)
    .sort((a, b) => b.median - a.median);
  const colOf = new Map<string, number>();
  colOf.set("name", nameCol);
  if (numericCols[0]) colOf.set("priceMinor", numericCols[0].c);
  if (numericCols[1]) colOf.set("stock", numericCols[1].c);
  return { colOf, detected: "guess" };
}

/**
 * Parse the first sheet into typed rows. Nothing here writes anything — the
 * preview owns the trust, the commit owns the writes.
 */
export function parseImportWorkbook(buffer: Buffer): { rows: ImportRow[]; detected: "header" | "guess" } {
  if (buffer.length > MAX_IMPORT_BYTES) {
    throw new Error("FILE_TOO_LARGE");
  }
  let grid: unknown[][];
  try {
    grid = readGrid(buffer);
  } catch {
    throw new Error("FILE_NOT_READABLE");
  }
  if (grid.length === 0) return { rows: [], detected: "header" };

  const asText = (r: unknown[]) => r.map((c) => String(c ?? "").trim());

  const colOf = new Map<string, number>();
  let headerIdx = -1;
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const found = matchHeaderRow((grid[i] ?? []).map(normHeader));
    if (found.has("name")) {
      headerIdx = i;
      colOf.clear();
      found.forEach((v, k) => colOf.set(k, v));
      break;
    }
  }
  let detected: ColumnMap["detected"] = "header";
  let dataStart = headerIdx + 1;
  if (headerIdx < 0) {
    // no header anywhere — guess from the data and eat the very first row too
    const textGrid = grid.map(asText);
    const guessed = guessColumns(textGrid);
    if (guessed.colOf.size === 0) throw new Error("HEADER_NOT_FOUND");
    guessed.colOf.forEach((v, k) => colOf.set(k, v));
    detected = "guess";
    dataStart = 0;
  }

  const cell = (cells: string[], f: string): string => {
    const idx = colOf.get(f);
    return idx === undefined ? "" : (cells[idx] ?? "").trim();
  };

  const rows: ImportRow[] = [];
  for (let i = dataStart; i < grid.length && rows.length < MAX_IMPORT_ROWS; i++) {
    const cells = asText(grid[i] ?? []);
    // skip rows that are entirely empty (silent separators)
    if (cells.every((c) => !c)) continue;
    const name = cell(cells, "name");
    if (!name) continue;
    // a guessed map can swallow a data row as «header»-adjacent noise — the
    // preview is the safety net; here we just read honestly
    rows.push({
      index: rows.length + 1,
      name: name.slice(0, 80),
      brand: cell(cells, "brand").slice(0, 60),
      spec: cell(cells, "spec").slice(0, 60),
      priceMinor: toIntOrNull(cell(cells, "priceMinor")),
      stock: toIntOrNull(cell(cells, "stock")),
      minOrder: toIntOrNull(cell(cells, "minOrder")),
      volume: toFloatOrNull(cell(cells, "volume")),
      imageUrl: toUrlOrNull(cell(cells, "imageUrl")),
      category: cell(cells, "category").slice(0, 60),
      subcategory: cell(cells, "subcategory").slice(0, 60),
    });
  }
  return { rows, detected };
}

/** toman → rial-minor for IRR (retailers think in toman); "rial" passes through. */
export function applyPriceUnit(rows: ImportRow[], priceUnit: "toman" | "rial"): ImportRow[] {
  if (priceUnit === "rial") return rows;
  return rows.map((r) => ({ ...r, priceMinor: r.priceMinor === null ? null : r.priceMinor * 10 }));
}
