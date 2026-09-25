import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { FilesModule } from "../files/files.module";
import { ProductsController } from "./products.controller";
import { ProductsService } from "./products.service";

/**
 * The shared SKU layer (Product between Good and Listing) — the picker feed
 * for retailers with hundreds of items + the Excel/CSV import engine +
 * the admin merge tool.
 */
@Module({
  imports: [AuthModule, FilesModule],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
