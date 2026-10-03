import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.module";
import { PushService } from "./push.service";

/**
 * انواع اعلان — MongoDB اِنام ندارد؛ در مرز API با type string می‌آید.
 *  FOLLOW_SUPPLIER — خریداری کاتالوگ (صفحه SELL) من را فالو کرد → مشتری جدید
 *  FOLLOW_BUYER    — تامین‌کننده‌ای میز خرید (صفحه BUY) مرا فالو کرد → «خودش آمد»
 *  OFFER           — پیشنهاد مستقیم روی درخواست خرید من نشست
 *  QUOTE           — موتور تطبیق، استعلام قیمت را به من رساند
 *  CONTACT_JOINED  — شماره‌ای از دفترچه‌ی من همین حالا عضو iMach شد
 *  PRICE_CHANGE    — فاز ۵ — کالایی که دنبال می‌کنم قیمتش عوض شد (شکاف ۲)
 *  BUYER_NEED      — طرح ۸ (U63) — خریداری که گوش‌به‌زنگش هستم نیاز جدید ثبت کرد
 */
export type NotificationType =
  | "FOLLOW_SUPPLIER"
  | "FOLLOW_BUYER"
  | "OFFER"
  | "QUOTE"
  | "CONTACT_JOINED"
  | "PRICE_CHANGE"
  | "BUYER_NEED";

export interface NotificationInput {
  userId: string;
  /**
   * فاز ۸ (طرح ۱۴) — کسب‌وکارِ گیرنده؛ فقط برای خواندن notifPrefs
   * (تنظیمات اعلان از پروفایل) به‌کار می‌رود و روی خودِ ردیف ذخیره
   * نمی‌شود. غایب = گیت نمی‌خورد (پیش‌فرض روشن).
   */
  bizId?: string | null;
  type: NotificationType;
  actorId?: string | null;
  actorName?: string | null;
  actorSlug?: string | null;
  good?: string | null;
}

/** نگاشت نوع اعلان → کلیدِ تنظیم در notifPrefs — null یعنی قابل‌تنظیم نیست */
const PREF_KEY: Record<NotificationType, string | null> = {
  PRICE_CHANGE: "priceChange",
  QUOTE: "quoteReplies",
  OFFER: "quoteReplies",
  FOLLOW_SUPPLIER: "suggestions",
  FOLLOW_BUYER: "suggestions",
  CONTACT_JOINED: "suggestions",
  BUYER_NEED: "quoteReplies",
};

/**
 * آینه‌ی TYPE_VIEWS سمت فرانت — متن و مقصدِ پوش باید همان اعلانِ درون‌برنامه‌ای
 * باشد (خواسته‌ی کاربر: «توی پوش نوتیفیکیشن هم همون اعلان‌ها میاد»).
 */
const PUSH_VIEWS: Record<
  NotificationType,
  { text: (n: NotificationInput) => string; url: string }
> = {
  FOLLOW_SUPPLIER: {
    text: (n) => `${n.actorName ?? "کاربری"} کاتالوگ شما را فالو کرد`,
    url: "/sell/customers",
  },
  FOLLOW_BUYER: {
    text: (n) => `${n.actorName ?? "کاربری"} لیست خرید شما را فالو کرد`,
    url: "/buy/suppliers",
  },
  OFFER: {
    text: (n) => `${n.actorName ?? "کاربری"} برای «${n.good ?? "کالا"}» پیشنهاد داد`,
    url: "/buy/panel",
  },
  QUOTE: {
    text: (n) => `درخواست قیمت برای «${n.good ?? "کالا"}»`,
    url: "/sell/requests",
  },
  CONTACT_JOINED: {
    text: (n) => `${n.actorName ?? "کسی"} عضو iMach شد`,
    url: "/market",
  },
  PRICE_CHANGE: {
    text: (n) => `قیمت «${n.good ?? "کالا"}» به‌روز شد`,
    url: "/buy",
  },
  BUYER_NEED: {
    text: (n) => `${n.actorName ?? "خریداری"} اعلام نیاز کرد: «${n.good ?? "کالا"}»`,
    url: "/sell/requests",
  },
};

/**
 * اطلاع‌رسانی درون‌برنامه‌ای — زنگِ هدر.
 * قاعده‌ی آهنین: اعلان هرگز جریان اصلی (فالو / پیشنهاد / استعلام / ثبت‌نام)
 * را نمی‌شکند — هر خطا اینجا بلعیده می‌شود و فقط ثبت نمی‌ماند.
 * هر ردیفِ درون‌برنامه‌ای، پوشِ همسان خودش را هم می‌فرستد (اگر اشتراک داشته باشد).
 *
 * فاز ۸ — گیتِ تنظیمات اعلان اینجا متمرکز شده (طرح ۱۴):
 *  • کلیدِ نوع خاموش باشد → ردیف اصلاً ساخته نمی‌شود (نه درون‌برنامه‌ای، نه پوش)
 *  • فقط «push» خاموش باشد → ردیفِ درون‌برنامه‌ای می‌ماند، پوشِ وب نمی‌رود
 *  • bizId غایب یا prefs نال → پیش‌فرض: همه روشن
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pushService: PushService
  ) {}

  async push(input: NotificationInput): Promise<void> {
    return this.pushMany([input]);
  }

  /** دسته‌ای — هر گیرنده یک ردیف به ازای هر رویداد (dedupe با userId). */
  async pushMany(rows: NotificationInput[]): Promise<void> {
    const seen = new Set<string>();
    const deduped = rows.filter((r) =>
      seen.has(r.userId) ? false : (seen.add(r.userId), true)
    );
    if (deduped.length === 0) return;

    const { inApp, canPush } = await this.filterByPrefs(deduped);
    if (inApp.length === 0) return;

    try {
      // bizId صرفاً سوئیچ خواندنِ prefs است — روی ردیف اعلان ذخیره نمی‌شود
      await this.prisma.notification.createMany({
        data: inApp.map(({ bizId: _bizId, ...rest }) => rest),
      });
    } catch {
      /* notification is best-effort — never break the main flow */
    }
    // پوشِ دسته‌ای — موازی روی گیرنده‌های یکتا (تنها کسانی که push روشن دارند)
    await Promise.allSettled(
      inApp.filter(canPush).map((r) => {
        const view = PUSH_VIEWS[r.type];
        if (!view) return Promise.resolve();
        return this.pushService
          .sendToUser(r.userId, { title: "iMach", body: view.text(r), url: view.url })
          .catch(() => {});
      })
    );
  }

  /**
   * تنظیمات اعلانِ گیرنده‌ها را یک فهرست‌خوانی می‌کند و ردیف‌ها را
   * به دو لایه جدا می‌کند: (۱) ردیف‌هایی که اصلاً مجازند ساخته شوند،
   * (۲) تابعِ «پوشِ وب مجاز است؟» برای همان ردیف‌ها. best-effort —
   * اگر خواندن prefs خطا بخورد، همه‌چیز پیش‌فرضِ روشن می‌ماند.
   */
  private async filterByPrefs(rows: NotificationInput[]): Promise<{
    inApp: NotificationInput[];
    canPush: (r: NotificationInput) => boolean;
  }> {
    const bizIds = [...new Set(rows.map((r) => r.bizId).filter((x): x is string => !!x))];
    if (bizIds.length === 0) return { inApp: rows, canPush: () => true };

    let prefs = new Map<string, Record<string, unknown> | null>();
    try {
      const bizs = await this.prisma.business.findMany({
        where: { id: { in: bizIds } },
        select: { id: true, notifPrefs: true },
      });
      prefs = new Map(bizs.map((b) => [b.id, (b.notifPrefs as Record<string, unknown> | null) ?? null]));
    } catch {
      /* prefs read is best-effort — defaults to all-on */
    }

    const read = (bizId: string, key: string): boolean => {
      const p = prefs.get(bizId);
      if (!p) return true;
      return p[key] !== false; // غایب/نال = روشن
    };

    return {
      inApp: rows.filter((r) => {
        const key = r.bizId ? PREF_KEY[r.type] : null;
        return !key || !r.bizId || read(r.bizId, key);
      }),
      canPush: (r: NotificationInput) => !r.bizId || read(r.bizId, "push"),
    };
  }
}
