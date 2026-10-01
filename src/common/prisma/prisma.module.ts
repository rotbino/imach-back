import { Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/**
 * Single PrismaClient per process — injected wherever data access is needed.
 *
 * onModuleInit پس از $connect یک کوئریِ گرم‌کردن شلیک می‌کند: اولین
 * findMany پرایسما روی کلاسترِ شاردشده تا حد کشف توپولوژی اتصال‌ها
 * ~۲ ثانیه طول می‌کشد — اگر این هزینه به اولین درخواستِ کاربر منتقل
 * شود، صفحه‌ی اول «کندی شدید» حس می‌شود (همان چیزی که کاربر گزارش
 * کرده بود). اینجا در بوت پرداخت می‌شود.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    const t0 = Date.now();
    await this.$connect();
    try {
      // گرم‌کردن پلن‌کَش و توپولوژی — کالکشن‌های مسیر داغ
      await Promise.all([
        this.product.findMany({ select: { id: true }, take: 1 }),
        this.good.findMany({ select: { id: true }, take: 1 }),
        this.category.findMany({ select: { id: true }, take: 1 }),
        this.listing.findMany({ select: { id: true }, take: 1 }),
        this.business.findMany({ select: { id: true }, take: 1 }),
      ]);
      this.logger.log(`Prisma connected + warmed in ${Date.now() - t0}ms`);
    } catch {
      /* warmup بهترین‌حال است — خطایش بوت را نمی‌شکند */
    }
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
