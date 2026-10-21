import { Module } from "@nestjs/common";
import { SettingsController } from "./settings.controller";
import { SettingsService } from "./settings.service";
import { PrismaModule } from "../common/prisma/prisma.module";
import { CacheModule } from "../common/cache/cache.module";

@Module({
  imports: [PrismaModule, CacheModule],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
