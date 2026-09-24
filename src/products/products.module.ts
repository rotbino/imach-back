import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ProductsController } from "./products.controller";
import { ProductsService } from "./products.service";

/**
 * The shared SKU layer (Product between Good and Listing) — the picker feed
 * for retailers with hundreds of items + the admin merge tool.
 */
@Module({
  imports: [AuthModule],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
