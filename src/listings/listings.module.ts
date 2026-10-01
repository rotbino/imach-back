import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { FilesModule } from "../files/files.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ProductsModule } from "../products/products.module";
import { ListingsController } from "./listings.controller";
import { ListingsPublicController } from "./listings-public.controller";

@Module({
  imports: [AuthModule, FilesModule, ProductsModule, NotificationsModule],
  controllers: [ListingsController, ListingsPublicController],
})
export class ListingsModule {}
