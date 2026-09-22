import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { env, jwtExpiresInSeconds } from "../common/config/env";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";

// توجه: AuthModule عمداً NotificationsModule را import نمی‌کند —
// NotificationsModule برای گاردش AuthModule را می‌خواهد و چرخه ممنوع.
// اعلان «مخاطب عضو شد» در AuthService مستقیم با prisma ساخته می‌شود.

@Module({
  imports: [
    JwtModule.register({
      secret: env.JWT_SECRET,
      signOptions: { expiresIn: jwtExpiresInSeconds() },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [JwtModule],
})
export class AuthModule {}
