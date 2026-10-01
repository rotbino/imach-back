import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ContactsController } from "./contacts.controller";

@Module({
  imports: [AuthModule],
  controllers: [ContactsController],
})
export class ContactsModule {}
