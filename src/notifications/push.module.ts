import { Module } from "@nestjs/common";
import { PushService } from "./push.service";

/**
 * Web Push — برگِ سبک: فقط PrismaModule گلوبال را لازم دارد، پس Auth و
 * Notifications هر دو می‌توانند بدون چرخه‌ی ماژولی واردش کنند.
 */
@Module({
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
