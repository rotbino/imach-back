import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { OrdersController } from "./orders.controller";

/** M5 — سفارش‌ها و اسناد (سند ۰۸ §M5). */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [OrdersController],
})
export class OrdersModule {}
