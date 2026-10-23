import { Module } from "@nestjs/common";
import { CommonModule } from "../common/common.module";
import { AuthModule } from "../auth/auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { SettingsModule } from "../settings/settings.module";
import { WalletModule } from "../wallet/wallet.module";
import { ScoreController } from "./score.controller";
import { ScoreService } from "./score.service";

/**
 * M7 — موتور امتیاز دوگانه + گیتِ شبکهٔ باز + دعوت‌شدگان.
 * صادرشده برای: Orders (تحویل ⇒ sc7/sb7) · Market (گیت‌ها) —
 * WalletModule فقط برای ثابت REFERRAL_REWARD_MINOR ایمپورت می‌شود
 * (سرویسِ آن اینجا تزریق نمی‌شود تا وابستگی سبک بماند).
 */
@Module({
  imports: [CommonModule, AuthModule, NotificationsModule, SettingsModule, WalletModule],
  controllers: [ScoreController],
  providers: [ScoreService],
  exports: [ScoreService],
})
export class ScoreModule {}
