import { Module } from "@nestjs/common";
import { FilesController } from "./files.controller";
import { FilesService } from "./files.service";
import { AuthModule } from "../auth/auth.module";

/**
 * Files feature module — controller + service + storage driver.
 * CommonModule (Prisma, cache) is global; AuthModule provides JwtAuthGuard.
 */
@Module({
  imports: [AuthModule],
  controllers: [FilesController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
