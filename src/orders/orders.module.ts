import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ScoreModule } from "../score/score.module";
import { OrdersController } from "./orders.controller";

/** M5 — سفارش‌ها و اسناد (سند ۰۸ §M5) + خط اتصال امتیاز M7 (sc7/sb7). */
@Module({
  imports: [AuthModule, NotificationsModule, ScoreModule],
  controllers: [OrdersController],
})
export class OrdersModule {}
