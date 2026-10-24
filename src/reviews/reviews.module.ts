import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ReviewsController } from "./reviews.controller";
import { ReviewsService } from "./reviews.service";

/** M10 — نظرات و امتیاز کاتالوک (سند ۰۳ §۴.۱) */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [ReviewsController],
  providers: [ReviewsService],
})
export class ReviewsModule {}
