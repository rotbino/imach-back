/**
 * i18n base — locale resolution + message lookup for the API.
 *
 * Request flow:
 *   Accept-Language header (sent by the web client, mirrors the UI language)
 *     → main.ts onRequest hook decorates request.locale
 *     → services translate user-facing messages with t()
 *
 * Dictionaries live per-locale; a missing key falls back to the default
 * locale (fa), then to the inline fallback text at the call site.
 * Error responses also keep a stable machine `code`, so clients can map
 * messages themselves if they prefer.
 */

export const SUPPORTED_LOCALES = ["fa", "ar", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "fa";

/** Locales written right-to-left (drives direction-aware clients). */
const RTL_LOCALES: ReadonlySet<Locale> = new Set(["fa", "ar"]);

export function isRtlLocale(locale: Locale): boolean {
  return RTL_LOCALES.has(locale);
}

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
      for (const param of trimmed.split(";").slice(1).map((p) => p.trim())) {
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
 * Message dictionaries. Only keys that need server-side localization live
 * here (auth flows today). Other locales fall back to fa, then to the
 * inline fallback at the call site.
 */
const messages: Record<Locale, Record<string, string>> = {
  fa: {
    "auth.phoneTaken": "این شماره موبایل قبلاً ثبت شده است",
    "auth.invalidCredentials": "شماره موبایل یا رمز عبور اشتباه است",
    "auth.phoneRequired": "شماره موبایل معتبر نیست",
    "auth.passwordShort": "رمز عبور حداقل ۶ کاراکتر باشد",
    "auth.nameRequired": "نام خود را بنویسید",
    "auth.notBusinessOwner": "این کسب‌وکار متعلق به شما نیست",
    "auth.selfFollow": "نمی‌توانید کسب‌وکار خودتان را فالو کنید",
    "auth.slugExhausted": "نمی‌توان اسلاگ یکتا ساخت، دوباره تلاش کنید",
    "auth.rateLimited": "درخواست‌های شما زیاد است، کمی بعد تلاش کنید",
    "business.roleRequired": "حداقل یکی از گزینه‌های خرید یا فروش عمده را انتخاب کنید",
  },
  ar: {
    "auth.phoneTaken": "رقم الهاتف مسجل مسبقاً",
    "auth.invalidCredentials": "رقم الهاتف أو كلمة المرور غير صحيحة",
    "auth.phoneRequired": "رقم الهاتف غير صالح",
    "auth.passwordShort": "كلمة المرور ٦ أحرف على الأقل",
    "auth.nameRequired": "اكتب اسمك",
    "auth.notBusinessOwner": "هذا النشاط التجاري ليس ملكك",
    "auth.selfFollow": "لا يمكنك متابعة نشاطك التجاري",
    "auth.slugExhausted": "تعذر إنشاء معرف فريد، حاول مجدداً",
    "auth.rateLimited": "طلباتك كثيرة جداً، حاول بعد قليل",
    "business.roleRequired": "اختر شراء أو بيع بالجملة على الأقل",
  },
  en: {
    "auth.phoneTaken": "This phone number is already registered",
    "auth.invalidCredentials": "Wrong phone number or password",
    "auth.phoneRequired": "The phone number is not valid",
    "auth.passwordShort": "Password must be at least 6 characters",
    "auth.nameRequired": "Please write your name",
    "auth.notBusinessOwner": "This business does not belong to you",
    "auth.selfFollow": "You cannot follow your own business",
    "auth.slugExhausted": "Could not create a unique slug, please retry",
    "auth.rateLimited": "Too many requests, please retry later",
    "business.roleRequired": "Select wholesale buying or selling — at least one",
  },
};

/**
 * Translate a key with fallback chain:
 * requested locale → default locale → inline fallback → the key itself.
 */
export function t(locale: Locale, key: string, fallback?: string): string {
  return messages[locale]?.[key] ?? messages[DEFAULT_LOCALE][key] ?? fallback ?? key;
}
