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
 */
@Controller("chat")
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /** فهرست گفتگوهای من + جمع نخوانده‌ها (بج تب چت) */
  @Get("getThreads")
  async getThreads(@CurrentUser() user: AuthUser) {
    return this.chat.getThreads(user.id);
  }

  /** شروع (یا یافتن) گفتگو با یک کسب‌وکار */
  @Post("startThread")
  async startThread(@Body() body: StartThreadDto, @CurrentUser() user: AuthUser) {
    return this.chat.startThread(user.id, body.businessId, body.withBusinessId);
  }

  /** جزئیات گفتگو + ۱۰۰ پیام آخر — خودکار خوانده می‌شود */
  @Get("getThread/:id")
  async getThread(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.chat.getThread(user.id, id);
  }

  /** ارسال پیام */
  @Post("sendMessage")
  async sendMessage(@Body() body: SendMessageDto, @CurrentUser() user: AuthUser) {
    return this.chat.sendMessage(user.id, body.threadId, body.text ?? "", body.fileId);
  }
}
