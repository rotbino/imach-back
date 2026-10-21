import { Body, Controller, Get, Param, Put, UseGuards } from "@nestjs/common";
import { SettingsService } from "../../settings/settings.service";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { AdminGuard } from "../admin.guard";

/**
 * ─── Admin · settings ───────────────────────────────────────────────────────
 * فاز ۸ مهاجرت — سوییچ‌های سیستمی: پرداخت (روشن/خاموش) + نرخ‌های ارز.
 * whitelist و اعتبارسنجی در SettingsService؛ نوشتن کش «settings» را
 * باطل می‌کند تا پیکربندی عمومی حداکثر چند ثانیه بعد تازه شود.
 */

@Controller("admin/settings")
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminSettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  async list() {
    return this.settings.listAll();
  }

  @Put(":key")
  async write(@Param("key") key: string, @Body() body: { value: unknown }) {
    return this.settings.write(key, body.value);
  }
}
