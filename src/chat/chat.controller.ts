import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ChatService } from "./chat.service";

class StartThreadDto {
  /** کسب‌وکار خودم (فرستندهٔ طرف من) */
  @IsString() businessId!: string;
  /** کسب‌وکار طرف مقابل */
  @IsString() withBusinessId!: string;
  /** M8 (FD-22 تصمیم ۸) — سندی که گفتگو از دلِ آن شروع می‌شود:
   *  ORDER | OFFER | SUPPLY_PROPOSAL | LISTING؛ غایب = گفتگوی آزاد */
  @IsOptional()
  @IsString()
  contextType?: string;
  @IsOptional()
  @IsString()
  contextRefId?: string;
}

class SendMessageDto {
  @IsString() threadId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  text?: string;

  /** پیوست عکس — اختیاری، از /files/upload */
  @IsOptional()
  @IsString()
  fileId?: string;
}

/**
 * فاز ۶ مهاجرت — چت کاری (پورت sc-msgs / sc-chat).
 * باز کردن گفتگو = خواندن (بج نخوانده هم همان‌جا صفر می‌شود)؛
 * ارسال = متن (۱..۲۰۰۰ بعد از trim) + پیوست اختیاری عکس.
 * M8: startThread با زمینهٔ سند (FD-22) + heartbeat حضور (≤۱/۶۰s).
 */
@Controller("chat")
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /** فهرست گفتگوهای من + جمع نخوانده‌ها (بج تب چت) + نشان آنلاین طرف */
  @Get("getThreads")
  async getThreads(@CurrentUser() user: AuthUser) {
    return this.chat.getThreads(user.id);
  }

  /** شروع (یا یافتن) گفتگو با یک کسب‌وکار — با یا بدون زمینهٔ سند */
  @Post("startThread")
  async startThread(@Body() body: StartThreadDto, @CurrentUser() user: AuthUser) {
    return this.chat.startThread(
      user.id,
      body.businessId,
      body.withBusinessId,
      body.contextType,
      body.contextRefId
    );
  }

  /** جزئیات گفتگو + ۱۰۰ پیام آخر — خودکار خوانده می‌شود + زمینهٔ «دربارهٔ:» */
  @Get("getThread/:id")
  async getThread(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.chat.getThread(user.id, id);
  }

  /** ارسال پیام */
  @Post("sendMessage")
  async sendMessage(@Body() body: SendMessageDto, @CurrentUser() user: AuthUser) {
    return this.chat.sendMessage(user.id, body.threadId, body.text ?? "", body.fileId);
  }

  /** M8 — ضربان حضور (شل هر ≤۶۰s؛ آنلاین = ≤۹۰s) */
  @Post("heartbeat")
  async heartbeat(@CurrentUser() user: AuthUser) {
    return this.chat.heartbeat(user.id);
  }
}
