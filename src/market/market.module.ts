import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PromosModule } from "../promos/promos.module";
import { ScoreModule } from "../score/score.module";
import { MarketController } from "./market.controller";
import { MatchingService } from "./matching.service";

/** بازار + M7: گیتِ شبکهٔ باز (امتیاز ۱۰۰) روی پیشنهادها/موتور */
@Module({
  imports: [AuthModule, NotificationsModule, PromosModule, ScoreModule],
  controllers: [MarketController],
  providers: [MatchingService],
})
export class MarketModule {}
