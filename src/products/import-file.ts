/**
 * ─── Import file parser ──────────────────────────────────────────────────────
 * «کسی که کالای زیادی دارد باید راحت وارد کند» (خواسته‌ی کاربر) — فایل
 * اکسل/CSV خرده‌فروش همان‌طور که هست خوانده می‌شود: سرستون‌ها با مترادف‌های
 * فارسی/انگلیسی شناسایی می‌شوند، ترتیب ستون‌ها مهم نیست، قیمت با ارقام فارسی
 * یا جداکننده‌ی هزارگان هم تمیز می‌شود. هیچ قالب سخت‌گیری تحمیل نمی‌شود؛
 * فقط پنج ستون شناخته می‌شود و بقیه نادیده گرفته می‌شوند.
 */

import * as XLSX from "xlsx";

export interface ImportRow {
  index: number; // 1-based row number as the user sees it in their file
  name: string;
  brand: string;
  spec: string;
  priceMinor: number | null;
  stock: number | null;
  minOrder: number | null;
  volume: number | null;
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
};

/** Persian/English header synonyms — the first matching synonym wins. */
const HEADER_SYNONYMS: Record<keyof Omit<ImportRow, "index">, string[]> = {
  name: ["نام کالا", "کالا", "نام محصول", "نام", "محصول", "product", "name", "item", "title"],
  brand: ["برند", "مارک", "سازنده", "brand", "manufacturer"],
  spec: ["ویژگی", "مشخصات", "بسته‌بندی", "بسته بندی", "وزن", "اندازه", "spec", "size", "pack", "weight"],
  priceMinor: ["قیمت", "قیمت فروش", "قیمت واحد", "price", "unit price"],
  stock: ["موجودی", "تعداد", "stock", "qty", "quantity"],
  minOrder: ["حداقل سفارش", "حداقل", "min order", "moq"],
  volume: ["حجم", "حجم خرید", "volume"],
};

const MAX_IMPORT_ROWS = 500;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

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

function normHeader(s: unknown): string {
  return String(s ?? "")
    .replace(/\u200C/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Parse the first sheet into typed rows. Column identity comes from the
 * header row; when a column header is unknown, that column is ignored —
 * the user's own layout survives as-is.
 */
export function parseImportWorkbook(buffer: Buffer): ImportRow[] {
  if (buffer.length > MAX_IMPORT_BYTES) {
    throw new Error("FILE_TOO_LARGE");
  }
  let grid: unknown[][];
  try {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return [];
    grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", blankrows: false });
  } catch {
    throw new Error("FILE_NOT_READABLE");
  }
  if (grid.length === 0) return [];

  // the header row = the first row that mentions a known header anywhere
  let headerIdx = -1;
  const colOf = new Map<keyof Omit<ImportRow, "index">, number>();
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const cells = (grid[i] ?? []).map(normHeader);
    const found = new Map<keyof Omit<ImportRow, "index">, number>();
    for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS) as [keyof Omit<ImportRow, "index">, string[]][]) {
      const idx = cells.findIndex((c) => c && synonyms.some((s) => c === s || c === s.toLowerCase()));
      if (idx >= 0 && !found.has(field)) found.set(field, idx);
    }
    if (found.has("name")) {
      headerIdx = i;
      for (const [k, v] of found) colOf.set(k, v);
      break;
    }
  }
  if (headerIdx < 0) throw new Error("HEADER_NOT_FOUND");

  const rows: ImportRow[] = [];
  for (let i = headerIdx + 1; i < grid.length && rows.length < MAX_IMPORT_ROWS; i++) {
    const cells = (grid[i] ?? []).map((c) => String(c ?? "").trim());
    const cell = (f: keyof Omit<ImportRow, "index">): string => {
      const idx = colOf.get(f);
      return idx === undefined ? "" : (cells[idx] ?? "").trim();
    };
    const name = cell("name");
    if (!name) continue; // blank separator rows are skipped silently
    rows.push({
      index: rows.length + 1,
      name: name.slice(0, 80),
      brand: cell("brand").slice(0, 60),
      spec: cell("spec").slice(0, 60),
      priceMinor: toIntOrNull(cell("priceMinor")),
      stock: toIntOrNull(cell("stock")),
      minOrder: toIntOrNull(cell("minOrder")),
      volume: toIntOrNull(cell("volume")),
    });
  }
  return rows;
}

/** toman → rial-minor for IRR (retailers think in toman); "rial" passes through. */
export function applyPriceUnit(rows: ImportRow[], priceUnit: "toman" | "rial"): ImportRow[] {
  if (priceUnit === "rial") return rows;
  return rows.map((r) => ({ ...r, priceMinor: r.priceMinor === null ? null : r.priceMinor * 10 }));
}
