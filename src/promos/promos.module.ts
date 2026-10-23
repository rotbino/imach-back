import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { SettingsModule } from "../settings/settings.module";
import { WalletModule } from "../wallet/wallet.module";
import { PromosController } from "./promos.controller";
import { PromosService } from "./promos.service";

/** M7: گیتِ شبکهٔ باز روی تبلیغ هدفمند (scoreSell آگهی‌دهنده ≥ آستانه) */
@Module({
  imports: [PrismaModule, AuthModule, WalletModule, SettingsModule],
  controllers: [PromosController],
  providers: [PromosService],
  exports: [PromosService],
})
export class PromosModule {}
