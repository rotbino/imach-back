import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { FilesModule } from "../files/files.module";
import { ListingsController } from "./listings.controller";

@Module({
  imports: [AuthModule, FilesModule],
  controllers: [ListingsController],
})
export class ListingsModule {}
