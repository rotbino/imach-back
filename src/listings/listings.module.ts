import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ListingsController } from "./listings.controller";

@Module({
  imports: [AuthModule],
  controllers: [ListingsController],
})
export class ListingsModule {}
