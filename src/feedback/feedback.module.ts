import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { FeedbackController } from "./feedback.controller";
import { FeedbackService } from "./feedback.service";

/** M10 — بازخورد/پرسش‌وپاسخ + نظرات عمومی + فیلم‌های آموزشی (سند ۰۳ §۴.۲/۴.۳/۴.۶) */
@Module({
  imports: [AuthModule],
  controllers: [FeedbackController],
  providers: [FeedbackService],
})
export class FeedbackModule {}
