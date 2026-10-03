import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PromosModule } from "../promos/promos.module";
import { MarketController } from "./market.controller";
import { MatchingService } from "./matching.service";

@Module({
  imports: [AuthModule, NotificationsModule, PromosModule],
  controllers: [MarketController],
  providers: [MatchingService],
})
export class MarketModule {}
