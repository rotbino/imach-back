import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";

/**
 * اعلان‌های درون‌برنامه‌ای — Prisma سراسری است؛ AuthModule برای JwtService
 * گارد وارد می‌شود. رویدادها از دو مسیر push می‌شوند:
 *   • MarketController → NotificationsService (تزریق‌شده)
 *   • AuthService.registerUser → مستقیم با prisma (تا چرخه‌ی ماژولی درست نشود)
 */
@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
