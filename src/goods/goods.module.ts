import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { GoodsController } from "./goods.controller";

@Module({
  imports: [AuthModule],
  controllers: [GoodsController],
})
export class GoodsModule {}
