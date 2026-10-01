import { Module } from "@nestjs/common";
import { CacheModule } from "./cache/cache.module";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthController } from "./health.controller";

/** Cross-cutting infrastructure shared by every feature module. */
@Module({
  imports: [PrismaModule, CacheModule],
  controllers: [HealthController],
})
export class CommonModule {}
