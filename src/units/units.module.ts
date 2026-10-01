import { Module } from "@nestjs/common";
import { UnitsController } from "./units.controller";
import { PrismaModule } from "../common/prisma/prisma.module";
import { CacheModule } from "../common/cache/cache.module";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [PrismaModule, CacheModule, AuthModule],
  controllers: [UnitsController],
})
export class UnitsModule {}
