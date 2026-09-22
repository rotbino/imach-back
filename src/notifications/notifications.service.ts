import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.module";

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
 * اطلاع‌رسانی درون‌برنامه‌ای — زنگِ هدر.
 * قاعده‌ی آهنین: اعلان هرگز جریان اصلی (فالو / پیشنهاد / استعلام / ثبت‌نام)
 * را نمی‌شکند — هر خطا اینجا بلعیده می‌شود و فقط ثبت نمی‌ماند.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async push(input: NotificationInput): Promise<void> {
    try {
      await this.prisma.notification.create({ data: input });
    } catch {
      /* notification is best-effort — never break the main flow */
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
  }
}
