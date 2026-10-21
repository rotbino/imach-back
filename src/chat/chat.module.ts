import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";

/** فاز ۶ مهاجرت — چت کاری بین دو کسب‌وکار (sc-msgs / sc-chat). */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
