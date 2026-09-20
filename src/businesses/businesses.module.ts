import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BusinessesController } from "./businesses.controller";

@Module({
  imports: [AuthModule],
  controllers: [BusinessesController],
})
export class BusinessesModule {}
