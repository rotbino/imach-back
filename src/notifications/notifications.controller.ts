import { Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards, Body } from "@nestjs/common";
import { CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PrismaService } from "../common/prisma/prisma.module";
import { NotificationsService } from "./notifications.service";
import { PushService } from "./push.service";
import {
  NotificationsQueryDto,
  SubscribePushDto,
  UnsubscribePushDto,
} from "./dto/notifications.dto";

/**
 * زنگ اعلان‌ها — فید درون‌برنامه‌ای کاربر جاری.
 * خواندن: ۳۰ ردیف آخر + شمارنده‌ی نخوانده‌ها (پولینگ سمت کلاینت؛ بدون کش —
 * «زنده» بودن زنگ بخشی از خودش است).
 * علامت‌گذاری: همه با یک فراخوان خوانده می‌شوند (الگوی باز کردن پنل).
 */
@Controller("notifications")
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pushService: PushService
  ) {}

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

  // ── Web Push (VAPID) — همان اعلان‌ها، بیرون از اپ ──

  /** کلید عمومی VAPID برای pushManager.subscribe سمت مرورگر */
  @Get("getVapidPublicKey")
  getVapidPublicKey() {
    return { publicKey: this.pushService.publicKey };
  }

  /** مرورگر بعد از موافقت کاربر، اشتراکش را اینجا ثبت می‌کند */
  @Post("subscribePush")
  @HttpCode(HttpStatus.CREATED)
  async subscribePush(
    @CurrentUser() user: AuthUser,
    @Body() body: SubscribePushDto
  ) {
    await this.pushService.subscribe(user.id, {
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
    });
    return { ok: true };
  }

  /** خروج/لغو از یک مرورگر — endpoint همان اشتراک */
  @Post("unsubscribePush")
  @HttpCode(HttpStatus.OK)
  async unsubscribePush(@Body() body: UnsubscribePushDto) {
    await this.pushService.unsubscribe(body.endpoint);
    return { ok: true };
  }
}
