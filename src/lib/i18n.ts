/**
 * i18n base — locale resolution + message lookup for the API.
 *
 * Persian is the app's default dictionary today. When iMach goes
 * multilingual, fill the `en` (and future) dictionaries with the same
 * stable keys — request localization is already wired:
 *
 *   request  →  Accept-Language header (sent by the web client)
 *           →  plugins/i18n decorates request.locale + request.t()
 *           →  services use request.t("module.key", "fallback text")
 *
 * Error responses keep a stable machine `code` (language-independent),
 * so clients can map messages themselves if they prefer.
 */

export const SUPPORTED_LOCALES = ["fa", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "fa";

/** Locales written right-to-left (drives direction-aware clients). */
const RTL_LOCALES: ReadonlySet<Locale> = new Set(["fa"]);

export function isRtlLocale(locale: Locale): boolean {
  return RTL_LOCALES.has(locale);
}

/**
 * Message dictionaries. `fa` holds the live strings; other locales stay
 * empty for now and transparently fall back to the default locale.
 */
const messages: Record<Locale, Record<string, string>> = {
  fa: {
    "auth.phoneTaken": "این شماره موبایل قبلاً ثبت شده است",
    "auth.invalidCredentials": "شماره موبایل یا رمز عبور اشتباه است",
  },
  en: {}, // filled in the multilingual milestone — falls back to fa
};

export interface AcceptLanguageEntry {
  tag: string;
  quality: number;
}

/** Parse an Accept-Language header into tags ordered by quality. */
export function parseAcceptLanguage(header: string | undefined): AcceptLanguageEntry[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      const rawTag = trimmed.split(";")[0]?.trim() ?? "";
      let quality = 1;
      const qParam = trimmed.split(";").slice(1).map((p) => p.trim());
      for (const param of qParam) {
        const match = /^q\s*=\s*([\d.]+)$/.exec(param);
        if (match) quality = Number.parseFloat(match[1] ?? "1") || 0;
      }
      return { tag: rawTag.toLowerCase(), quality };
    })
    .filter((entry) => entry.tag.length > 0)
    .sort((a, b) => b.quality - a.quality);
}

/** Best supported locale for a request: Accept-Language → default. */
export function resolveLocale(header: string | undefined): Locale {
  for (const { tag } of parseAcceptLanguage(header)) {
    const base = tag.split("-")[0] ?? "";
    if ((SUPPORTED_LOCALES as readonly string[]).includes(base)) return base as Locale;
  }
  return DEFAULT_LOCALE;
}

/**
 * Translate a message key with fallback chain:
 * requested locale → default locale → inline fallback → the key itself.
 */
export function t(locale: Locale, key: string, fallback?: string): string {
  return (
    messages[locale]?.[key] ??
    messages[DEFAULT_LOCALE][key] ??
    fallback ??
    key
  );
}
