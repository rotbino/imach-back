import { Module } from "@nestjs/common";
import { BrandController } from "./brand.controller";
import { PrismaModule } from "../common/prisma/prisma.module";
import { CacheModule } from "../common/cache/cache.module";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [PrismaModule, CacheModule, AuthModule],
  controllers: [BrandController],
})
export class BrandModule {}
