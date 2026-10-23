import { Module } from "@nestjs/common";
import { CommonModule } from "../common/common.module";
import { AuthModule } from "../auth/auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { SupplyProposalsController } from "./supply-proposals.controller";

/** M6 — پیشنهاد تامین: از نمای عمومی لیست خرید تا دو رابطهٔ Follow. */
@Module({
  imports: [CommonModule, AuthModule, NotificationsModule],
  controllers: [SupplyProposalsController],
})
export class SupplyProposalsModule {}
