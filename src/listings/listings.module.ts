import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { FilesModule } from "../files/files.module";
import { ProductsModule } from "../products/products.module";
import { ListingsController } from "./listings.controller";

@Module({
  imports: [AuthModule, FilesModule, ProductsModule],
  controllers: [ListingsController],
})
export class ListingsModule {}
