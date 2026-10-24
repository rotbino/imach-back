import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { RepController } from "./rep.controller";
import { RepService } from "./rep.service";

/**
 * M9 — نمایندهٔ فروش (FD-17 · سند ۰۸ §M9): سفارشِ گرفته‌شده توسط
 * نماینده، جدا از ماژول orders (قواعد دوطرفه شاملش نمی‌شود). چرخهٔ
 * بازاریاب سنتی: ثبت → ارسال لیست (بیرون از سیستم) → تحویل → تسویه.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [RepController],
  providers: [RepService],
})
export class RepModule {}
