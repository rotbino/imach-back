import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { FilesModule } from "../files/files.module";
import { AdminOverviewController } from "./overview/overview.controller";
import { AdminGoodsController } from "./goods/goods.controller";
import { AdminBrandsController } from "./brands/brands.controller";
import { AdminCategoriesController } from "./categories/categories.controller";
import { AdminFilesController } from "./files/admin-files.controller";

/**
 * Self-contained admin feature module — the ONLY place admin API code lives.
 * One folder per entity (overview / goods / brands / categories / files / …): the
 * surface grows by adding a folder and registering its controller here, and
 * any day the whole tree can lift into its own deployable as one piece.
 */
@Module({
  imports: [AuthModule, FilesModule],
  controllers: [
    AdminOverviewController,
    AdminGoodsController,
    AdminBrandsController,
    AdminCategoriesController,
    AdminFilesController,
  ],
})
export class AdminModule {}
