import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { FilesModule } from "../files/files.module";
import { AdminOverviewController } from "./overview/overview.controller";
import { AdminGoodsController } from "./goods/goods.controller";
import { AdminBrandsController } from "./brands/brands.controller";
import { AdminCategoriesController } from "./categories/categories.controller";
import { AdminFilesController } from "./files/admin-files.controller";
import { AdminSettingsController } from "./settings/admin-settings.controller";
import { SettingsModule } from "../settings/settings.module";

/**
 * Self-contained admin feature module — the ONLY place admin API code lives.
 * One folder per entity (overview / goods / brands / categories / files / …): the
 * surface grows by adding a folder and registering its controller here, and
 * any day the whole tree can lift into its own deployable as one piece.
 */
@Module({
  imports: [AuthModule, FilesModule, SettingsModule],
  controllers: [
    AdminOverviewController,
    AdminGoodsController,
    AdminBrandsController,
    AdminCategoriesController,
    AdminFilesController,
    AdminSettingsController,
  ],
})
export class AdminModule {}
