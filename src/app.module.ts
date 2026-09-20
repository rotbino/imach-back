import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { CommonModule } from "./common/common.module";
import { AuthModule } from "./auth/auth.module";
import { GoodsModule } from "./goods/goods.module";
import { BusinessesModule } from "./businesses/businesses.module";
import { ListingsModule } from "./listings/listings.module";
import { MarketModule } from "./market/market.module";

/**
 * iMach API root — feature modules only; cross-cutting infra lives in
 * CommonModule (Prisma, cache, i18n, errors, pagination, geo).
 * Global rate limit: 300 req/min/IP (auth controller tightens to 15).
 */
@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    CommonModule,
    AuthModule,
    GoodsModule,
    BusinessesModule,
    ListingsModule,
    MarketModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
