import { Controller, Param, Post } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.module";

/**
 * POST /listings/view/:id — شمارش بازدید عمومی کالا (شکاف ۳ — فاز ۲).
 *
 * چرا کنترلر جدا؟ صفحه‌ی جزئیات کالا برای «مهمان» هم باز است؛ این اندپوینت
 * بدون JWT کار می‌کند (برخلاف بقیه‌ی listings که همه مالک‌اند). سوءاستفاده‌ی
 * آن فقط شمارش را متورم می‌کند — نه داده‌ی تجاری‌ای تغییر نمی‌کند؛ تراتل
 * عمومی (۳۰۰/دقیقه) جلوی اسپرم را می‌گیرد.
 *
 * پنجره‌ی سی‌روزه: هر بار که از ۳۰ روز بگذرد، شمارنده‌ی پنجره ریست و از
 * امروز شروع می‌شود — همان «۲۱ بازدید» کارت‌ها و «عملکرد ۳۰ روز اخیر».
 */
@Controller("listings")
export class ListingsPublicController {
  constructor(private readonly prisma: PrismaService) {}

  @Post("view/:id")
  async view(@Param("id") id: string) {
    if (!/^[0-9a-fA-F]{24}$/.test(id)) return { ok: false };
    const listing = await this.prisma.listing.findUnique({
      where: { id },
      select: { id: true, isActive: true, mode: true, viewWindowStart: true },
    });
    // کالای حذف‌شده/خریدی بازدید حساب نمی‌شود — بی‌صدا
    if (!listing || !listing.isActive || !(listing.mode === "SELL" || listing.mode === "BOTH")) {
      return { ok: false };
    }
    const now = new Date();
    const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
    const expired =
      !listing.viewWindowStart || now.getTime() - listing.viewWindowStart.getTime() > WINDOW_MS;
    await this.prisma.listing.update({
      where: { id: listing.id },
      data: expired
        ? { viewCountTotal: { increment: 1 }, viewCount30: 1, viewWindowStart: now }
        : { viewCountTotal: { increment: 1 }, viewCount30: { increment: 1 } },
    });
    return { ok: true };
  }
}
