// ─── Catalog helpers — text normalization + currency registry ────────────────

/**
 * Locale-tolerant normalization for search & dedup:
 * Arabic yeh/kaf → Persian, diacritics dropped, ZWNJ → space,
 * Persian/Arabic digits → Latin, lowercase. Both seed names and user
 * queries go through this, so «کیک» and «كیک» find the same good.
 */
export function normalizeFa(input: string): string {
  return input
    .trim()
    .replace(/[\u064A\u0649]/g, "\u06CC") // ي ى → ی
    .replace(/\u0643/g, "\u06A9") // ك → ک
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "") // harakat + tatweel
    .replace(/\u200C/g, " ") // ZWNJ → space
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0)) // ۰-۹
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)) // ٠-٩
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** searchText of a good: canonical names + aliases, normalized once. */
export function goodSearchText(parts: {
  nameFa: string;
  nameEn?: string | null;
  aliases?: string[];
}): string {
  return normalizeFa(
    [parts.nameFa, parts.nameEn ?? "", ...(parts.aliases ?? [])].filter(Boolean).join(" ")
  );
}

// ─── Currency registry (ISO 4217, minor-unit exponent) ─────────────────────
// Money is ALWAYS stored as an integer in the smallest currency unit
// (rial, cent, …). exp = 10^exp minor units per major unit.

interface CurrencyDef {
  exp: number;
}

export const CURRENCIES: Record<string, CurrencyDef> = {
  IRR: { exp: 0 },
  USD: { exp: 2 },
  EUR: { exp: 2 },
  GBP: { exp: 2 },
  AED: { exp: 2 },
  TRY: { exp: 2 },
  CNY: { exp: 2 },
  INR: { exp: 2 },
  PKR: { exp: 2 },
  AFN: { exp: 2 },
  IQD: { exp: 3 },
  RUB: { exp: 2 },
  SAR: { exp: 2 },
  QAR: { exp: 2 },
  KWD: { exp: 3 },
  BHD: { exp: 3 },
  OMR: { exp: 3 },
  SYP: { exp: 2 },
  LBP: { exp: 2 },
  JOD: { exp: 3 },
  EGP: { exp: 2 },
  YER: { exp: 2 },
  TMT: { exp: 2 },
  AZN: { exp: 2 },
  AMD: { exp: 2 },
};

export const isCurrency = (code: string): boolean => code in CURRENCIES;

/** Country → default catalog currency (signup drives this). */
export const COUNTRY_CURRENCY: Record<string, string> = {
  IR: "IRR",
  AF: "AFN",
  PK: "PKR",
  TM: "TMT",
  AZ: "AZN",
  AM: "AMD",
  TR: "TRY",
  IQ: "IQD",
  SY: "SYP",
  AE: "AED",
  SA: "SAR",
  QA: "QAR",
  KW: "KWD",
  BH: "BHD",
  OM: "OMR",
  YE: "YER",
  LB: "LBP",
  JO: "JOD",
  EG: "EGP",
  CN: "CNY",
  IN: "INR",
  RU: "RUB",
  DE: "EUR",
  FR: "EUR",
  IT: "EUR",
  GB: "GBP",
  US: "USD",
};

/**
 * Country → ITU calling code (no plus, no trunk 0).
 * The phone identity of a user is stored as dial + national number without
 * the leading 0 (e.g. Iran 0912… → 98912…) so the same local number from
 * two different countries can never collide.
 */
export const DIAL_OF: Record<string, string> = {
  IR: "98",
  AF: "93",
  PK: "92",
  TM: "993",
  AZ: "994",
  AM: "374",
  TR: "90",
  IQ: "964",
  SY: "963",
  AE: "971",
  SA: "966",
  QA: "974",
  KW: "965",
  BH: "973",
  OM: "968",
  YE: "967",
  LB: "961",
  JO: "962",
  EG: "20",
  CN: "86",
  IN: "91",
  RU: "7",
  DE: "49",
  GB: "44",
  US: "1",
};

export const dialOfCountry = (code: string): string => DIAL_OF[code] ?? "98";

export const isSupportedCountry = (code: string): boolean => code in COUNTRY_CURRENCY;

export const currencyOfCountry = (code: string): string => COUNTRY_CURRENCY[code] ?? "IRR";
