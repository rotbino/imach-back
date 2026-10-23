import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { FastifyRequest } from "fastify";
import type { AuthUser } from "../common/decorators/auth.decorators";

/**
 * M6 — گیت اختیاری برای دیدهای عمومیِ بیننده‌دار (کاتالوگ عمومی ۳۱ /
 * لیست خرید عمومی ۳۲).
 *
 * بدون هدر = مهمان (request.user تعریف نمی‌شود؛ مسیر باز می‌ماند).
 * با هدرِ معتبر = request.user مثل JwtAuthGuard پر می‌شود.
 * با هدرِ خراب/منقضی = مهمان رفتار می‌کند (نه ۴۰۱) — دید عمومی هرگز
 * به توکن کهنه نمی‌شکند؛ گیت حساب فقط روی اکشن‌های ثبت‌شده است.
 *
 * امنیت: `request.user` فقط بعد از verify موفق ست می‌شود؛ کنترلرها
 * بدون توکن هرگز هویت نمی‌گیرند (devtools دورزدنی نیست — دادهٔ gated
 * در همان پاسخ سرور حذف می‌شود).
 */
@Injectable()
export class OptionalJwtGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) return true; // مهمان — مسیر باز

    try {
      const payload = await this.jwt.verifyAsync<AuthUser>(token);
      request.user = { id: payload.id, phone: payload.phone, role: payload.role };
    } catch {
      /* توکن کهنه/خراب — مهمان ساده؛ دید عمومی نمی‌شکند */
    }
    return true;
  }
}
