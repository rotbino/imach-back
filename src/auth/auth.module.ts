import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { env, jwtExpiresInSeconds } from "../common/config/env";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { OptionalJwtGuard } from "./optional-jwt.guard";
import { PushModule } from "../notifications/push.module";

// توجه: AuthModule عمداً NotificationsModule را import نمی‌کند —
// NotificationsModule برای گاردش AuthModule را می‌خواهد و چرخه ممنوع.
// PushModule برگِ سبک است (هیچ‌چیز را import نمی‌کند) — بدون چرخه وارد می‌شود
// تا «مخاطب عضو شد» هم پوش بگیرد؛ خودِ ردیف اعلان همان‌طور مستقیم با prisma.

// undefined = کلید expiresIn از signOptions حذف می‌شود → توکن بدون claim «exp»
// و بدون انقضا (تصمیم مالک: JWT_EXPIRES_IN="never").
const jwtExpiresIn = jwtExpiresInSeconds();

@Module({
  imports: [
    JwtModule.register({
      secret: env.JWT_SECRET,
      signOptions: jwtExpiresIn === undefined ? {} : { expiresIn: jwtExpiresIn },
    }),
    PushModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, OptionalJwtGuard],
  exports: [JwtModule, JwtAuthGuard, OptionalJwtGuard],
})
export class AuthModule {}
