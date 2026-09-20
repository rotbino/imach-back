import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { MarketController } from "./market.controller";
import { MatchingService } from "./matching.service";

@Module({
  imports: [AuthModule],
  controllers: [MarketController],
  providers: [MatchingService],
})
export class MarketModule {}
