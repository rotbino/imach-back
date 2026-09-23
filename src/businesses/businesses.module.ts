import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { FilesModule } from "../files/files.module";
import { BusinessesController } from "./businesses.controller";

@Module({
  imports: [AuthModule, FilesModule],
  controllers: [BusinessesController],
})
export class BusinessesModule {}
