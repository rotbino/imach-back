import { Module } from "@nestjs/common";
import { UnitsController } from "./units.controller";
import { PrismaModule } from "../common/prisma/prisma.module";
import { CacheModule } from "../common/cache/cache.module";

@Module({
  imports: [PrismaModule, CacheModule],
  controllers: [UnitsController],
})
export class UnitsModule {}
