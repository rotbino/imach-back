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
 */
export type NotificationType =
  | "FOLLOW_SUPPLIER"
  | "FOLLOW_BUYER"
  | "OFFER"
  | "QUOTE"
  | "CONTACT_JOINED";

export interface NotificationInput {
  userId: string;
  type: NotificationType;
  actorId?: string | null;
  actorName?: string | null;
  actorSlug?: string | null;
  good?: string | null;
}

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
    url: "/sell/panel",
  },
  CONTACT_JOINED: {
    text: (n) => `${n.actorName ?? "کسی"} عضو iMach شد`,
    url: "/market",
  },
};

/**
 * اطلاع‌رسانی درون‌برنامه‌ای — زنگِ هدر.
 * قاعده‌ی آهنین: اعلان هرگز جریان اصلی (فالو / پیشنهاد / استعلام / ثبت‌نام)
 * را نمی‌شکند — هر خطا اینجا بلعیده می‌شود و فقط ثبت نمی‌ماند.
 * هر ردیفِ درون‌برنامه‌ای، پوشِ همسان خودش را هم می‌فرستد (اگر اشتراک داشته باشد).
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pushService: PushService
  ) {}

  async push(input: NotificationInput): Promise<void> {
    try {
      await this.prisma.notification.create({ data: input });
    } catch {
      /* notification is best-effort — never break the main flow */
    }
    const view = PUSH_VIEWS[input.type];
    if (view) {
      await this.pushService
        .sendToUser(input.userId, {
          title: "iMach",
          body: view.text(input),
          url: view.url,
        })
        .catch(() => {});
    }
  }

  /** دسته‌ای — هر گیرنده یک ردیف به ازای هر رویداد (dedupe با userId). */
  async pushMany(rows: NotificationInput[]): Promise<void> {
    const seen = new Set<string>();
    const data = rows.filter((r) =>
      seen.has(r.userId) ? false : (seen.add(r.userId), true)
    );
    if (data.length === 0) return;
    try {
      await this.prisma.notification.createMany({ data });
    } catch {
      /* notification is best-effort — never break the main flow */
    }
    // پوشِ دسته‌ای — موازی روی گیرنده‌های یکتا
    await Promise.allSettled(
      data.map((r) => {
        const view = PUSH_VIEWS[r.type];
        if (!view) return Promise.resolve();
        return this.pushService
          .sendToUser(r.userId, { title: "iMach", body: view.text(r), url: view.url })
          .catch(() => {});
      })
    );
  }
}
