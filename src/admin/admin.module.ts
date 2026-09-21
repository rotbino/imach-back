import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AdminController } from "./admin.controller";

/**
 * Self-contained admin feature module — the ONLY place admin API code lives.
 * When the admin surface grows (or splits into its own service) this module
 * moves as one piece; feature modules stay untouched.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminController],
})
export class AdminModule {}
