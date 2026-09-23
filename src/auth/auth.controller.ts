import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CurrentLocale, CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { AuthService } from "./auth.service";
import { LoginUserDto, RegisterUserDto, CheckPhoneDto } from "./dto/auth.dto";

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
}
