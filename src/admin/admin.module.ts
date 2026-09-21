import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AdminOverviewController } from "./overview/overview.controller";
import { AdminGoodsController } from "./goods/goods.controller";
import { AdminBrandsController } from "./brands/brands.controller";
import { AdminCategoriesController } from "./categories/categories.controller";

/**
 * Self-contained admin feature module — the ONLY place admin API code lives.
 * One folder per entity (overview / goods / brands / categories / …): the
 * surface grows by adding a folder and registering its controller here, and
 * any day the whole tree can lift into its own deployable as one piece.
 */
@Module({
  imports: [AuthModule],
  controllers: [
    AdminOverviewController,
    AdminGoodsController,
    AdminBrandsController,
    AdminCategoriesController,
  ],
})
export class AdminModule {}
