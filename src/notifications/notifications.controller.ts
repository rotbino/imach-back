import { Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from "@nestjs/common";
import { CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PrismaService } from "../common/prisma/prisma.module";
import { NotificationsQueryDto } from "./dto/notifications.dto";

/**
 * زنگ اعلان‌ها — فید درون‌برنامه‌ای کاربر جاری.
 * خواندن: ۳۰ ردیف آخر + شمارنده‌ی نخوانده‌ها (پولینگ سمت کلاینت؛ بدون کش —
 * «زنده» بودن زنگ بخشی از خودش است).
 * علامت‌گذاری: همه با یک فراخوان خوانده می‌شوند (الگوی باز کردن پنل).
 */
@Controller("notifications")
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("getNotifications")
  async getNotifications(
    @CurrentUser() user: AuthUser,
    @Query() query: NotificationsQueryDto
  ) {
    const cap = Math.min(query.limit ?? 30, 50);
    const [rows, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId: user.id },
        orderBy: { id: "desc" },
        take: cap,
      }),
      this.prisma.notification.count({ where: { userId: user.id, read: false } }),
    ]);
    return { items: rows, unreadCount };
  }

  @Post("readAll")
  @HttpCode(HttpStatus.OK)
  async readAll(@CurrentUser() user: AuthUser) {
    await this.prisma.notification.updateMany({
      where: { userId: user.id, read: false },
      data: { read: true },
    });
    return { ok: true };
  }
}
