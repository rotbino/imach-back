import { Injectable, Logger } from "@nestjs/common";
import * as webpush from "web-push";
import { PrismaService } from "../common/prisma/prisma.module";
import { env } from "../common/config/env";

/**
 * Web Push (VAPID) — استاندارد بازِ W3C؛ بدون نیاز به ثبت‌نام گوگل/FCM.
 * هر مرورگر یک اشتراک دارد (PushSubscription)؛ سرور با کلید VAPID به
 * سرویسِ پوشِ همان مرورگر (FCMخودکار کروم / Mozilla autopush / …) POST می‌زند.
 *
 * قاعده‌ی آهستان مثل NotificationsService: بهترین‌تلاش — هیچ‌وقت جریان اصلی
 * (فالو / پیشنهاد / استعلام / ثبت‌نام) را نمی‌شکند. 404/410 سرویس پوش یعنی
 * اشتراک مرده (کاربر پاکش کرده) → ردیف حذف می‌شود.
 */

export interface PushPayload {
  title: string;
  body: string;
  /** مقصد کلیک روی اعلان — همان مقصدِ ردیفِ همان اعلان در زنگِ اپ */
  url?: string;
}

export interface SubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private configured = false;

  constructor(private readonly prisma: PrismaService) {
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
      webpush.setVapidDetails(
        env.VAPID_SUBJECT,
        env.VAPID_PUBLIC_KEY,
        env.VAPID_PRIVATE_KEY
      );
      this.configured = true;
    } else {
      this.logger.warn("VAPID keys missing — web push is disabled (in-app bell still works)");
    }
  }

  /** کلید عمومی برای subscribe سمت مرورگر — بدون کلید، فرانت دکمه را نشان نمی‌دهد */
  get publicKey(): string {
    return this.configured ? env.VAPID_PUBLIC_KEY : "";
  }

  async subscribe(userId: string, sub: SubscriptionInput): Promise<void> {
    // همان مرورگر دوباره subscribe کرد → ردیفش به‌روز شود (نه تکراری)
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: { userId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
      update: { userId, p256dh: sub.p256dh, auth: sub.auth },
    });
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({ where: { endpoint } });
  }

  async sendToUser(userId: string, payload: PushPayload): Promise<void> {
    if (!this.configured) return;
    let subs: { id: string; endpoint: string; p256dh: string; auth: string }[] = [];
    try {
      subs = await this.prisma.pushSubscription.findMany({ where: { userId } });
    } catch {
      return; // DB لحظه‌ای در دسترس نیست — پوش جا نماندنِ جریان اصلی مهم‌تر است
    }
    if (subs.length === 0) return;

    await Promise.allSettled(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify(payload),
            { TTL: 60 * 60 * 24 } // یک روز — اعلانِ B2B کهنه بی‌ارزش است
          );
        } catch (err: any) {
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            // اشتراک مرده — دیگر هیچ‌وقت به این endpoint نرس
            await this.prisma.pushSubscription
              .deleteMany({ where: { id: s.id } })
              .catch(() => {});
          } else {
            this.logger.debug(`push delivery failed: ${err?.message ?? err}`);
          }
        }
      })
    );
  }
}
