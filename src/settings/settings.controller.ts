import { Controller, Get } from "@nestjs/common";
import { FastifyReply } from "fastify";
import { Res } from "@nestjs/common";
import { SettingsService } from "./settings.service";

/**
 * فاز ۸ مهاجرت — پیکربندی عمومی سیستم (بدون احراز هویت):
 * نمایش ارز + نرخ‌ها + سوییچ پرداخت. کش ۵ دقیقه‌ای در سرویس.
 */
@Controller("settings")
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get("config")
  async config(@Res({ passthrough: true }) reply: FastifyReply) {
    const value = await this.settings.publicConfig();
    reply.header("cache-control", "public, max-age=60");
    return value;
  }
}
