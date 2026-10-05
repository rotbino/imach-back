import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CurrentLocale, CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import type { Locale } from "../common/i18n/i18n";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { AuthService } from "./auth.service";
import { LoginUserDto, QuickRegisterDto, RegisterUserDto, SetPasswordDto, CheckPhoneDto } from "./dto/auth.dto";

/**
 * Auth endpoints — deliberately action-named for readability
 * (loginUser, registerUser, …) so client and server read the same.
 * Brute-force surface is tight: 15 attempts/min/IP on this controller.
 */
@Controller("auth")
@Throttle({ default: { limit: 15, ttl: 60_000 } })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("registerUser")
  @HttpCode(201)
  registerUser(
    @Body() body: RegisterUserDto,
    @Res({ passthrough: true }) reply: FastifyReply,
    @CurrentLocale() locale: Parameters<typeof AuthService.prototype.registerUser>[2]
  ) {
    return this.authService.registerUser(body, reply, locale);
  }

  @Post("checkPhone")
  @HttpCode(200)
  checkPhone(
    @Body() body: CheckPhoneDto,
    @CurrentLocale() locale: Parameters<typeof AuthService.prototype.checkPhone>[1]
  ) {
    return this.authService.checkPhone(body, locale);
  }

  @Post("loginUser")
  @HttpCode(200)
  loginUser(
    @Body() body: LoginUserDto,
    @Res({ passthrough: true }) reply: FastifyReply,
    @CurrentLocale() locale: Parameters<typeof AuthService.prototype.loginUser>[2]
  ) {
    return this.authService.loginUser(body, reply, locale);
  }

  /**
   * Quick register — only mobile, no password (خواسته‌ی کاربر: «ثبت‌نام را
   * راحت کنم»). کاربر شماره را می‌زند، سشن می‌گیرد و مستقیم وارد کاتالوگش
   * می‌شود؛ Business خودکار با نام «کاتالوگ شما» ساخته می‌شود. اگر شماره
   * قبلاً با پسورد ثبت شده باشد، این endpoint رد می‌کند تا کاربر وارد شود.
   */
  @Post("quickRegister")
  @HttpCode(201)
  quickRegister(
    @Body() body: QuickRegisterDto,
    @Res({ passthrough: true }) reply: FastifyReply,
    @CurrentLocale() locale: Parameters<typeof AuthService.prototype.quickRegisterUser>[2]
  ) {
    return this.authService.quickRegisterUser(body, reply, locale);
  }

  /**
   * Set password — برای کاربرانی که ثبت‌نام سریع کرده‌اند (passwordSet=false)
   * یا می‌خواهند پسوردشان را عوض کنند.
   */
  @Post("setPassword")
  @UseGuards(JwtAuthGuard)
  setPassword(
    @Body() body: SetPasswordDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    return this.authService.setPassword(user, body, locale);
  }

  @Post("refreshSession")
  @HttpCode(200)
  refreshSession(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    return this.authService.refreshSession(request, reply);
  }

  @Post("logoutUser")
  @UseGuards(JwtAuthGuard)
  logoutUser(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    return this.authService.logoutUser(request, reply);
  }

  @Get("getMe")
  @UseGuards(JwtAuthGuard)
  getMe(@CurrentUser() user: AuthUser) {
    return this.authService.getMe(user);
  }

  /**
   * فاز ۶ مهاجرت — ترجیحات نمایش کاربر: تم روشن/تاریک، رنگ دلخواه هر arm،
   * زبان. ادغامی (merge) — فقط کلیدهای ارسال‌شده عوض می‌شوند. cross-device.
   */
  @Post("setPrefs")
  @UseGuards(JwtAuthGuard)
  setPrefs(
    @Body()
    body: {
      theme?: string;
      armBuyColor?: string | null;
      armSellColor?: string | null;
      lang?: string;
      /** فاز ۸ — ارز نمایش (ISO 4217 · null = ارز مرجع) */
      currency?: string | null;
    },
    @CurrentUser() user: AuthUser
  ) {
    return this.authService.setPrefs(user, body);
  }

  /**
   * Edit profile — نام و نام خانوادگی مالک کسب‌وکار را به‌روزرسانی می‌کند.
   * این فیلدها در ویترین کاتالوگ زیر عنوان نشان داده می‌شوند (خواسته‌ی کاربر).
   */
  @Post("editProfile")
  @UseGuards(JwtAuthGuard)
  editProfile(
    @Body() body: { firstName?: string; lastName?: string },
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    return this.authService.editProfile(user, body, locale);
  }
}
