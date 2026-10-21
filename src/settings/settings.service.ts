import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.module";
import { CacheService, TTL } from "../common/cache/cache.module";
import { AppError } from "../common/errors/app-error";

/**
 * فاز ۸ مهاجرت — تنظیمات سیستمی (AppSetting): سوییچ‌های ادمین و پیکربندی
 * بین‌المللی. مخزن key/value در Atlas؛ خواندن عمومی با کش ۵ دقیقه‌ای.
 *
 * کلیدهای شناخته‌شده (whitelist — سرویس مقدار را اعتبارسنجی می‌کند):
 *   payments.enabled  (bool, پیش‌فرض true)   — درگاه پرداخت فقط ایران؛ ادمین خاموش می‌کند
 *   currency.base     ("IRR", فقط-خواندنی)   — ارز مرجع حسابداری
 *   currency.rates    ({CODE: baseMinorPerMajor}) — نرخ‌ها؛ rate.IRR ≡ ۱۰ (لنگر)
 *
 * نرخ = چند minor ارز مرجع برابر ۱ واحد اصلیِ آن ارز (مثلاً USD ≈ ۸۴۰٬۰۰۰
 * یعنی هر دلار ≈ ۸۴ هزار تومان). تبدیل نمایشی روی کلاینت انجام می‌شود؛
 * حسابداری کیف/کمپین همیشه در ارز مرجع می‌ماند (یک منبع حقیقت).
 */

/** کلیدهای مجاز برای نوشتن توسط ادمین */
const WRITABLE_KEYS = ["payments.enabled", "currency.rates"] as const;

/** ارزهای پشتیبانی‌شدهٔ نمایش (برچسب‌ها سمت کلاینت) — IRR لنگر است */
export const SUPPORTED_CURRENCIES = [
  "IRR", "USD", "EUR", "GBP", "AED", "TRY", "CNY", "INR", "PKR", "AFN",
  "IQD", "RUB", "SAR", "QAR", "KWD", "BHD", "OMR", "SYP", "LBP", "JOD",
  "EGP", "YER", "TMT", "AZN", "AMD",
] as const;

/** نرخ‌های پیش‌فرض seed — تقریبی و قابل‌ویرایش توسط ادمین (بدون API خارجی) */
const DEFAULT_RATES: Record<string, number> = {
  IRR: 10, // لنگر — همیشه ۱۰ (۱ تومان = ۱۰ ریال)
  USD: 840_000, // ۱ دلار ≈ ۸۴٬۰۰۰ تومان
  EUR: 920_000,
  GBP: 1_070_000,
  AED: 229_000,
  TRY: 24_000,
  CNY: 116_000,
  INR: 10_000,
  PKR: 3_000,
  AFN: 12_000,
  IQD: 640,
  RUB: 9_800,
  SAR: 224_000,
  QAR: 231_000,
  KWD: 2_740_000,
  BHD: 2_230_000,
  OMR: 2_180_000,
  SYP: 65,
  LBP: 9,
  JOD: 1_190_000,
  EGP: 17_000,
  YER: 3_400,
  TMT: 240_000,
  AZN: 494_000,
  AMD: 2_200,
};

const DEFAULTS: Record<string, unknown> = {
  "payments.enabled": true,
  "currency.base": "IRR",
  "currency.rates": DEFAULT_RATES,
};

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService
  ) {}

  /** خواندن یک کلید با seed خودکار (اولین خواندن مقدار پیش‌فرض را می‌نویسد) */
  private async readKey(key: string): Promise<unknown> {
    const row = await this.prisma.appSetting.findUnique({ where: { key } });
    if (row) return row.value;
    // seed — upsert برای هم‌زمانی؛ رقابت بی‌ضرر است
    await this.prisma.appSetting
      .upsert({
        where: { key },
        create: { key, value: DEFAULTS[key] as object },
        update: {},
      })
      .catch(() => null);
    return DEFAULTS[key];
  }

  /** پیکربندی عمومی — خوراک فرانت (نمایش ارز + سوییچ پرداخت) */
  async publicConfig() {
    const { value } = await this.cache.wrap(
      "settings:public",
      { ttlMs: 5 * TTL.MINUTE, tags: ["settings"] },
      async () => {
        const [paymentsEnabled, base, rates] = await Promise.all([
          this.readKey("payments.enabled"),
          this.readKey("currency.base"),
          this.readKey("currency.rates"),
        ]);
        return {
          paymentsEnabled: paymentsEnabled === true,
          base: typeof base === "string" ? base : "IRR",
          rates: this.sanitizeRates(rates),
          currencies: [...SUPPORTED_CURRENCIES],
        };
      }
    );
    return value;
  }

  /** نرخ‌های معتبر فقط — عدد مثبت متناهی */
  private sanitizeRates(raw: unknown): Record<string, number> {
    const out: Record<string, number> = { IRR: 10 };
    if (raw && typeof raw === "object") {
      for (const [code, v] of Object.entries(raw as Record<string, unknown>)) {
        if (
          (SUPPORTED_CURRENCIES as readonly string[]).includes(code) &&
          typeof v === "number" &&
          Number.isFinite(v) &&
          v > 0
        ) {
          out[code] = v;
        }
      }
    }
    return out;
  }

  /** کلیدهای نگاشتی برای پنل ادمین */
  async listAll() {
    const keys = [...new Set([...WRITABLE_KEYS, ...Object.keys(DEFAULTS)])];
    const rows = await this.prisma.appSetting.findMany({ where: { key: { in: keys } } });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = byKey.get(k) ?? DEFAULTS[k];
    return {
      settings: out,
      writable: WRITABLE_KEYS,
      currencies: [...SUPPORTED_CURRENCIES],
    };
  }

  /** نوشتن ادمین — whitelist + اعتبارسنجی ساختاری + باطل‌کردن کش */
  async write(key: string, value: unknown) {
    if (!(WRITABLE_KEYS as readonly string[]).includes(key)) {
      throw AppError.badRequest("این کلید قابل نوشتن نیست", "SETTING_KEY_NOT_WRITABLE");
    }
    let sanitized: unknown;
    if (key === "payments.enabled") {
      sanitized = value === true || value === "true";
    } else if (key === "currency.rates") {
      sanitized = this.sanitizeRates(value);
    }
    const row = await this.prisma.appSetting.upsert({
      where: { key },
      create: { key, value: sanitized as object },
      update: { value: sanitized as object },
    });
    this.cache.invalidateTag("settings");
    return row;
  }

  /** سوییچ پرداخت برای گیت‌های داخلی (کیف/شارژ) */
  async paymentsEnabled(): Promise<boolean> {
    const v = await this.readKey("payments.enabled");
    return v === true;
  }
}
