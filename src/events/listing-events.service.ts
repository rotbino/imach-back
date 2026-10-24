import { Global, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.module";

/**
 * M10 (N5 · سند ۰۳ §۴.۴) — نویسندهٔ خط زمانی کالا (ListingEventLog).
 *
 * قاعدهٔ حجم: VIEW هرگز این‌جا نمی‌نشیند (شمارندهٔ viewCount30/Total کارش را
 * می‌کند)؛ فقط رویدادهای غیر-بازدید یا بازدیدِ تبلیغیِ شارژشونده:
 *   WATCH_ADD    — خریدار کالا را به لیست خریدش افزود (watchGood — روی همهٔ
 *                  آگهی‌های فروشِ فعال همان کالا؛ هر فروشنده ردیف خودش را می‌بیند)
 *   INQUIRY      — استعلام قیمت (requestQuote — روی اقلامِ آگهیِ همان فروشنده)
 *   CHAT         — گفتگو با زمینهٔ همین کالا (startThread contextType=LISTING)
 *   CAMPAIGN_VIEW— بازدیدِ شارژیِ تبلیغ (promos chargeEvent VIEW)
 *
 * هر نوشتن best-effort است: خطا هرگز جریان اصلی را نمی‌شکند (الگوی
 * NotificationsService) — زیرا همهٔ فراخوان‌ها داخل مسیرهای هسته‌اند.
 */
export type ListingEventType = "WATCH_ADD" | "COMPARE_ADD" | "INQUIRY" | "CHAT" | "CAMPAIGN_VIEW";

@Global()
@Injectable()
export class ListingEventsService {
  private readonly logger = new Logger(ListingEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** یک رویداد روی یک آگهی — بی‌سروصدا اگر نشد */
  async log(listingId: string, type: ListingEventType, actor?: { businessId: string | null; name: string | null }): Promise<void> {
    try {
      await this.prisma.listingEventLog.create({
        data: {
          listingId,
          type,
          actorBusinessId: actor?.businessId ?? null,
          actorName: actor?.name ?? null,
        },
      });
    } catch {
      /* best-effort — تاریخچه هرگز ذخیرهٔ اصلی را نمی‌شکند */
    }
  }

  /** WATCH_ADD روی همهٔ آگهی‌های فروشِ فعالِ یک کالا (خریدار کالا را دنبال کرد) */
  async logWatchOnGood(goodId: string, actor: { businessId: string; name: string }): Promise<void> {
    try {
      const listings = await this.prisma.listing.findMany({
        where: { goodId, isActive: true, mode: { in: ["SELL", "BOTH"] } },
        select: { id: true },
        take: 500,
      });
      if (listings.length === 0) return;
      await this.prisma.listingEventLog.createMany({
        data: listings.map((l) => ({
          listingId: l.id,
          type: "WATCH_ADD" as const,
          actorBusinessId: actor.businessId,
          actorName: actor.name,
        })),
      });
    } catch (e) {
      this.logger.debug(`WATCH_ADD log skipped: ${e instanceof Error ? e.message : "?"}`);
    }
  }

  /** INQUIRY روی اقلامِ خودِ فروشنده (snapshot رزولوشن‌شدهٔ همان استعلام) */
  async logInquiry(items: { listingId: string | null }[], actor: { businessId: string; name: string }): Promise<void> {
    try {
      const ids = [...new Set(items.map((i) => i.listingId).filter((x): x is string => !!x))];
      if (ids.length === 0) return;
      await this.prisma.listingEventLog.createMany({
        data: ids.map((listingId) => ({
          listingId,
          type: "INQUIRY" as const,
          actorBusinessId: actor.businessId,
          actorName: actor.name,
        })),
      });
    } catch (e) {
      this.logger.debug(`INQUIRY log skipped: ${e instanceof Error ? e.message : "?"}`);
    }
  }
}
