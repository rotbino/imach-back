import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OptionalJwtGuard } from "../auth/optional-jwt.guard";
import { AdminGuard } from "../admin/admin.guard";
import { FeedbackService, type FeedbackArm, type FeedbackKind } from "./feedback.service";

class ListFeedbackDto {
  @IsIn(["FEEDBACK", "QUESTION"]) kind!: FeedbackKind;
  @IsIn(["BUY", "SELL"]) arm!: FeedbackArm;
  @IsOptional() @IsString() businessId?: string;
}

class CreateFeedbackDto {
  @IsString() businessId!: string;
  @IsIn(["FEEDBACK", "QUESTION"]) kind!: FeedbackKind;
  @IsIn(["BUY", "SELL"]) arm!: FeedbackArm;
  @IsString() @MaxLength(700) text!: string;
}

class LikeDto {
  @IsString() businessId!: string;
}

class ReplyDto {
  @IsOptional() @IsString() businessId?: string;
  @IsString() @MaxLength(500) text!: string;
}

class SubmitTestimonialDto {
  @IsString() @MaxLength(60) name!: string;
  @IsString() @MaxLength(80) business!: string;
  @IsOptional() @IsString() @MaxLength(80) role?: string;
  @IsOptional() @IsBoolean() isBuyer?: boolean;
  @IsOptional() @IsString() @MaxLength(40) feature?: string;
  @IsString() @MaxLength(600) text!: string;
}

/**
 * M10 — بازخورد/پرسش‌وپاسخ دستیارها + نظرات عمومی ویترین + فیلم‌های آموزشی
 * (سند ۰۶ §feedback). خواندن‌ها عمومی؛ نوشتن احرازشده؛ testimonial آزاد
 * (صف تأیید ادمین)؛ تأیید/رد فقط ADMIN.
 */
@Controller("feedback")
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  // ── بازخورد و پرسش‌وپاسخ راهنماها (N3) ─────────────────────────────

  @Get()
  @UseGuards(OptionalJwtGuard)
  async list(@Query() query: ListFeedbackDto, @CurrentUser() user: AuthUser | undefined) {
    return this.feedback.list(query.kind, query.arm, query.businessId);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Body() body: CreateFeedbackDto, @CurrentUser() user: AuthUser) {
    return this.feedback.create(user, body.businessId, body.kind, body.arm, body.text);
  }

  @Post(":id/like")
  @UseGuards(JwtAuthGuard)
  async like(@Param("id") id: string, @Body() body: LikeDto, @CurrentUser() user: AuthUser) {
    return this.feedback.toggleLike(user, id, body.businessId);
  }

  @Post(":id/reply")
  @UseGuards(JwtAuthGuard)
  async reply(@Param("id") id: string, @Body() body: ReplyDto, @CurrentUser() user: AuthUser) {
    return this.feedback.reply(user, id, body.businessId ?? null, body.text);
  }

  // ── نظرات عمومی ویترین (N4) ────────────────────────────────────────

  /** عمومی — فقط تأییدشده‌ها (لندینگ + صفحهٔ سایر نظرات) */
  @Get("testimonials")
  async testimonials() {
    return this.feedback.listApproved();
  }

  /** ثبت نظر — مهمان لندینگ هم می‌فرستد؛ نمایش پس از تأیید ادمین */
  @Post("testimonials")
  async submitTestimonial(@Body() body: SubmitTestimonialDto) {
    return this.feedback.submit(body);
  }

  /** صف ادمین — همهٔ نظرات (در انتظار + تأییدشده) */
  @Get("testimonials/queue")
  @UseGuards(JwtAuthGuard, AdminGuard)
  async queue() {
    return this.feedback.adminQueue();
  }

  @Post("testimonials/:id/approve")
  @UseGuards(JwtAuthGuard, AdminGuard)
  async approve(@Param("id") id: string) {
    return this.feedback.approve(id);
  }

  @Post("testimonials/:id/reject")
  @UseGuards(JwtAuthGuard, AdminGuard)
  async reject(@Param("id") id: string) {
    return this.feedback.reject(id);
  }

  // ── فیلم‌های آموزشی (N3-محتوا) ─────────────────────────────────────

  @Get("video-lessons")
  async lessons(@Query("arm") arm: FeedbackArm) {
    return this.feedback.listLessons(arm);
  }
}
